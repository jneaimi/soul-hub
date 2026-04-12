import { dirname, resolve } from 'node:path';
import { parseChain, getChainExecutionLevels, resolveChainRef } from './chain-parser.js';
import { runPipeline, killPipeline } from './runner.js';
import { parsePipeline } from './parser.js';
import { parseCondition, evaluateConditionOp } from './condition-evaluator.js';
import type { ChainSpec, ChainRun, ChainNodeRun, ChainNodeStatus } from './chain-types.js';
import type { StepStatus } from './types.js';
import { getVaultEngine } from '../vault/index.js';

/** Track active chain runs for kill support: chainRunId → set of inner pipeline runIds */
const activeChainRuns = new Map<string, Set<string>>();

/** Get the output path from a completed pipeline run.
 *  Returns the last non-skipped, non-approval, non-prompt step's outputPath. */
function extractNodeOutput(nodeRun: ChainNodeRun): string {
	if (!nodeRun.pipelineRun) return '';
	const steps = nodeRun.pipelineRun.steps;
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i];
		if (s.status === 'done' && s.outputPath && s.outputPath !== '/dev/null') {
			return s.outputPath;
		}
	}
	return '';
}

/** Get output for a specific step within a node's pipeline run */
function extractNodeStepOutput(nodeRun: ChainNodeRun, stepId: string): string {
	if (!nodeRun.pipelineRun) return '';
	const step = nodeRun.pipelineRun.steps.find((s) => s.id === stepId);
	return step?.outputPath || '';
}

/** Evaluate when/skip_if conditions for chain nodes.
 *  Supports $nodes.X.output and $inputs.X references in conditions. */
function evaluateChainCondition(
	expr: string,
	inputs: Record<string, string | number>,
	nodeOutputs: Record<string, string>,
): boolean {
	const { left, op, right } = parseCondition(expr);
	const resolvedLeft = resolveChainRef(left, inputs, nodeOutputs);
	return evaluateConditionOp(resolvedLeft, op, right);
}

/** Check if a node should be skipped based on when/skip_if */
function checkChainCondition(
	node: { when?: string; skip_if?: string; id: string },
	inputs: Record<string, string | number>,
	nodeOutputs: Record<string, string>,
): { skip: boolean; reason?: string } {
	if (node.when) {
		const result = evaluateChainCondition(node.when, inputs, nodeOutputs);
		if (!result) return { skip: true, reason: `when: ${node.when}` };
	}
	if (node.skip_if) {
		const result = evaluateChainCondition(node.skip_if, inputs, nodeOutputs);
		if (result) return { skip: true, reason: `skip_if: ${node.skip_if}` };
	}
	return { skip: false };
}

/** Get all downstream dependents of a node (transitive) */
function getDownstream(nodeId: string, spec: ChainSpec): Set<string> {
	const downstream = new Set<string>();
	const queue = [nodeId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const node of spec.nodes) {
			if (node.depends_on?.includes(current) && !downstream.has(node.id)) {
				downstream.add(node.id);
				queue.push(node.id);
			}
		}
	}
	return downstream;
}

/** Run a chain (pipeline-of-pipelines DAG orchestrator) */
export async function runChain(
	yamlPath: string,
	inputOverrides: Record<string, string | number>,
	onNodeEvent?: (nodeId: string, status: ChainNodeStatus, detail?: string) => void,
	onStepEvent?: (nodeId: string, stepId: string, status: StepStatus, detail?: string) => void,
	onStepOutput?: (nodeId: string, stepId: string, data: string) => void,
	externalRunId?: string,
	preSpec?: ChainSpec,
): Promise<ChainRun> {
	const spec = preSpec || await parseChain(yamlPath);
	const pipelinesDir = resolve(dirname(yamlPath), '..');
	const runId = externalRunId || crypto.randomUUID().slice(0, 8);

	// Track inner pipeline runs for kill support
	const innerRunIds = new Set<string>();
	activeChainRuns.set(runId, innerRunIds);

	// Resolve chain-level inputs
	const resolvedInputs: Record<string, string | number> = {};
	for (const input of spec.inputs || []) {
		resolvedInputs[input.name] = inputOverrides[input.name] ?? input.default ?? '';
	}

	// Track node outputs for handoff
	const nodeOutputs: Record<string, string> = {};
	// Also track per-step outputs: "nodeId:stepId" → path
	const nodeStepOutputs: Record<string, string> = {};

	// Build node run state
	const nodeRuns = new Map<string, ChainNodeRun>();
	for (const node of spec.nodes) {
		const nr: ChainNodeRun = {
			id: node.id,
			pipelineName: node.pipeline,
			status: 'pending',
			attempt: 0,
		};
		nodeRuns.set(node.id, nr);
	}

	const chainRun: ChainRun = {
		runId,
		chainName: spec.name,
		type: 'chain',
		status: 'running',
		startedAt: new Date().toISOString(),
		nodes: [...nodeRuns.values()],
		resolvedInputs,
	};

	const strategy = spec.on_failure?.strategy ?? 'halt-branch';
	const skippedNodes = new Set<string>();
	let halted = false;

	// Get execution levels
	const levels = getChainExecutionLevels(spec);

	for (const level of levels) {
		if (halted) break;

		// Filter out skipped nodes
		const activeNodes = level.filter((id) => !skippedNodes.has(id));
		if (activeNodes.length === 0) continue;

		const results = await Promise.allSettled(
			activeNodes.map(async (nodeId) => {
				const node = spec.nodes.find((n) => n.id === nodeId)!;
				const nr = nodeRuns.get(nodeId)!;

				// Check when/skip_if conditions
				const condition = checkChainCondition(node, resolvedInputs, nodeOutputs);
				if (condition.skip) {
					nr.status = 'skipped';
					nr.error = condition.reason;
					nodeOutputs[nodeId] = '';
					onNodeEvent?.(nodeId, 'skipped', condition.reason);
					return;
				}

				// Resolve node inputs: map chain inputs/node outputs to pipeline inputs
				const pipelineInputs: Record<string, string | number> = {};
				for (const [key, value] of Object.entries(node.inputs || {})) {
					if (typeof value === 'string') {
						// Merge node-level and step-level outputs for resolution
						const allOutputs = { ...nodeOutputs, ...nodeStepOutputs };
						pipelineInputs[key] = resolveChainRef(value, resolvedInputs, allOutputs);
					} else {
						pipelineInputs[key] = value;
					}
				}

				const maxAttempts = (node.retry ?? 0) + 1;
				let lastError = '';

				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					nr.attempt = attempt;
					nr.status = 'running';
					nr.startedAt = new Date().toISOString();
					onNodeEvent?.(nodeId, 'running', attempt > 1 ? `Retry ${attempt}/${maxAttempts}` : undefined);

					const innerRunId = `${runId}-${nodeId}`;
					innerRunIds.add(innerRunId);

					try {
						const pipelineYaml = resolve(pipelinesDir, node.pipeline, 'pipeline.yaml');
						const result = await runPipeline(
							pipelineYaml,
							pipelineInputs,
							onStepEvent ? (stepId, status, detail) => onStepEvent(nodeId, stepId, status, detail) : undefined,
							onStepOutput ? (stepId, data) => onStepOutput(nodeId, stepId, data) : undefined,
							innerRunId,
						);

						nr.pipelineRun = result;
						innerRunIds.delete(innerRunId);

						if (result.status === 'done') {
							nr.status = 'done';
							nr.finishedAt = new Date().toISOString();
							nr.durationMs = new Date(nr.finishedAt).getTime() - new Date(nr.startedAt!).getTime();
							nr.outputPath = extractNodeOutput(nr);
							nodeOutputs[nodeId] = nr.outputPath || '';
							// Store per-step outputs for $nodes.X.output.step-id references
							for (const step of result.steps) {
								if (step.outputPath && step.outputPath !== '/dev/null') {
									nodeStepOutputs[`${nodeId}:${step.id}`] = step.outputPath;
								}
							}
							onNodeEvent?.(nodeId, 'done');
							return;
						} else {
							lastError = result.steps.find((s) => s.error)?.error || 'Pipeline failed';
							if (attempt === maxAttempts) {
								nr.status = 'failed';
								nr.finishedAt = new Date().toISOString();
								nr.durationMs = new Date(nr.finishedAt).getTime() - new Date(nr.startedAt!).getTime();
								nr.error = lastError;
								onNodeEvent?.(nodeId, 'failed', lastError);
								throw new Error(lastError);
							}
						}
					} catch (err) {
						innerRunIds.delete(innerRunId);
						lastError = err instanceof Error ? err.message : String(err);
						if (attempt === maxAttempts) {
							nr.status = 'failed';
							nr.finishedAt = new Date().toISOString();
							nr.durationMs = new Date(nr.finishedAt).getTime() - new Date(nr.startedAt!).getTime();
							nr.error = lastError;
							onNodeEvent?.(nodeId, 'failed', lastError);
							throw err;
						}
					}
				}
			}),
		);

		// Process failures based on strategy
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === 'rejected') {
				const failedNodeId = activeNodes[i];

				if (strategy === 'halt') {
					halted = true;
					// Kill any still-running inner pipelines
					for (const id of innerRunIds) {
						killPipeline(id);
					}
					// Mark all remaining nodes as skipped
					for (const node of spec.nodes) {
						const nr = nodeRuns.get(node.id)!;
						if (nr.status === 'pending') {
							nr.status = 'skipped';
							nr.error = `Halted due to failure of node "${failedNodeId}"`;
							skippedNodes.add(node.id);
							onNodeEvent?.(node.id, 'skipped', nr.error);
						}
					}
					break;
				} else {
					// halt-branch / skip-dependents: skip downstream only
					const downstream = getDownstream(failedNodeId, spec);
					for (const depId of downstream) {
						const nr = nodeRuns.get(depId)!;
						if (nr.status === 'pending') {
							nr.status = 'skipped';
							nr.error = `Skipped: upstream node "${failedNodeId}" failed`;
							skippedNodes.add(depId);
							onNodeEvent?.(depId, 'skipped', nr.error);
						}
					}
					nodeOutputs[failedNodeId] = '';
				}
			}
		}
	}

	// Finalize chain run
	chainRun.nodes = [...nodeRuns.values()];
	const anyFailed = chainRun.nodes.some((n) => n.status === 'failed');
	chainRun.status = anyFailed ? 'failed' : 'done';
	chainRun.finishedAt = new Date().toISOString();

	activeChainRuns.delete(runId);

	// Save chain run summary to vault (non-blocking)
	try {
		const engine = getVaultEngine();
		if (engine) {
			const date = chainRun.startedAt.slice(0, 10);
			const shortId = runId.slice(0, 8);
			const zone = `projects/${chainRun.chainName}/outputs`;
			const filename = `${date}-chain-run-${shortId}.md`;

			const durationSec = Math.floor(
				(new Date(chainRun.finishedAt!).getTime() - new Date(chainRun.startedAt).getTime()) / 1000
			);
			const durationStr = durationSec < 60 ? `${durationSec}s` :
				`${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

			const nodeCounts = { done: 0, failed: 0, skipped: 0 };
			for (const node of chainRun.nodes) {
				if (node.status === 'done') nodeCounts.done++;
				else if (node.status === 'failed') nodeCounts.failed++;
				else nodeCounts.skipped++;
			}

			let content = `# Chain Run: ${chainRun.chainName}\n\nPart of [[projects/${chainRun.chainName}/index|${chainRun.chainName}]]\n\n`;
			content += `## Summary\n\n`;
			content += `- **Status**: ${chainRun.status === 'done' ? 'Success' : 'Failed'}\n`;
			content += `- **Run ID**: \`${runId}\`\n`;
			content += `- **Duration**: ${durationStr}\n`;
			content += `- **Nodes**: ${nodeCounts.done} done, ${nodeCounts.failed} failed, ${nodeCounts.skipped} skipped\n`;
			content += `- **Date**: ${date}\n\n`;

			content += `## Nodes\n\n`;
			content += `| Node | Pipeline | Status | Duration |\n`;
			content += `|------|----------|--------|----------|\n`;
			for (const node of chainRun.nodes) {
				const dur = node.durationMs ? `${(node.durationMs / 1000).toFixed(1)}s` : '-';
				content += `| ${node.id} | ${node.pipelineName} | ${node.status} | ${dur} |\n`;
			}

			const tags = ['chain', 'run-summary', chainRun.chainName];
			if (chainRun.status === 'failed') tags.push('failed');

			engine.createNote({
				zone,
				filename,
				meta: {
					type: 'output',
					created: date,
					tags,
					project: chainRun.chainName,
					chain: chainRun.chainName,
					run_id: runId,
					status: chainRun.status,
					duration_sec: durationSec,
				},
				content,
			}).catch(err => console.error('[vault/chain] Chain summary save failed:', err));
		}
	} catch (err) {
		console.error('[vault/chain] Chain summary error:', err);
	}

	return chainRun;
}

/** Kill a running chain and all its inner pipeline runs */
export function killChain(chainRunId: string): boolean {
	const innerRunIds = activeChainRuns.get(chainRunId);
	if (!innerRunIds) return false;

	let killed = false;
	for (const id of innerRunIds) {
		if (killPipeline(id)) killed = true;
	}
	activeChainRuns.delete(chainRunId);
	return killed;
}
