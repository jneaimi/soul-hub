import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { runPipeline, parsePipeline, validatePipelineRun, sendInputToStep, killPipeline, approveGate, rejectGate, answerGate, getActivePipelines, getSavedInputs, saveInputs, parseChain, validateChainRun, runChain, killChain, recordManualRun } from '$lib/pipeline/index.js';
import type { PipelineRun } from '$lib/pipeline/types.js';
import type { ChainRun } from '$lib/pipeline/chain-types.js';
import { access } from 'node:fs/promises';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

// Track active and completed runs (in-memory for live polling)
const runs = new Map<string, PipelineRun>();
const chainRuns = new Map<string, ChainRun>();
const runEvents = new Map<string, { stepId: string; status: string; detail?: string; time: string }[]>();

// Track terminal output per step (ring buffer — last 200 lines per step)
const stepOutputBuffers = new Map<string, Map<string, string[]>>();

// Use shared concurrency lock from scheduler
const activePipelines = getActivePipelines();

/** POST /api/pipelines/run — start, kill, or send input to a pipeline */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Handle interaction: send input to a running step's PTY
	if (body.action === 'input') {
		const { stepId, data } = body;
		if (!stepId || !data) return json({ error: 'Missing stepId or data' }, { status: 400 });
		const sent = sendInputToStep(stepId, data);
		return json({ ok: sent });
	}

	// Handle kill: abort a running pipeline or chain
	if (body.action === 'kill') {
		const { runId } = body;
		if (!runId) return json({ error: 'Missing runId' }, { status: 400 });

		// Try chain kill first, then pipeline
		const chainKilled = killChain(runId);
		if (chainKilled) {
			const cr = chainRuns.get(runId);
			if (cr) {
				cr.status = 'failed';
				cr.finishedAt = new Date().toISOString();
				activePipelines.delete(cr.chainName);
			}
			const events = runEvents.get(runId);
			events?.push({ stepId: '_chain', status: 'killed', detail: 'Killed by user', time: new Date().toISOString() });
			return json({ ok: true });
		}

		const killed = killPipeline(runId);
		if (killed) {
			const run = runs.get(runId);
			if (run) {
				run.status = 'failed';
				run.finishedAt = new Date().toISOString();
				activePipelines.delete(run.pipelineName);
			}
			const events = runEvents.get(runId);
			events?.push({ stepId: '_pipeline', status: 'killed', detail: 'Killed by user', time: new Date().toISOString() });
		}
		return json({ ok: killed || chainKilled });
	}

	// Handle approve: resolve a waiting approval gate
	if (body.action === 'approve') {
		const { runId, stepId } = body;
		if (!runId || !stepId) return json({ error: 'Missing runId or stepId' }, { status: 400 });
		const ok = approveGate(runId, stepId);
		if (ok) {
			const events = runEvents.get(runId);
			events?.push({ stepId, status: 'approved', time: new Date().toISOString() });
		}
		return json({ ok });
	}

	// Handle reject: fail a waiting approval gate
	if (body.action === 'reject') {
		const { runId, stepId, reason } = body;
		if (!runId || !stepId) return json({ error: 'Missing runId or stepId' }, { status: 400 });
		const ok = rejectGate(runId, stepId, reason || 'Rejected by user');
		if (ok) {
			const events = runEvents.get(runId);
			events?.push({ stepId, status: 'rejected', detail: reason || 'Rejected by user', time: new Date().toISOString() });
		}
		return json({ ok });
	}

	// Handle answer: provide input for a waiting prompt gate
	if (body.action === 'answer') {
		const { runId, stepId, value } = body;
		if (!runId || !stepId || value === undefined) return json({ error: 'Missing runId, stepId, or value' }, { status: 400 });
		const ok = answerGate(runId, stepId, value);
		if (ok) {
			const events = runEvents.get(runId);
			events?.push({ stepId, status: 'answered', detail: value, time: new Date().toISOString() });
		}
		return json({ ok });
	}

	const { name, inputs, resumeFrom } = body as { name: string; inputs?: Record<string, string | number>; resumeFrom?: string };

	if (!name) {
		return json({ error: 'Missing pipeline name' }, { status: 400 });
	}

	// Concurrency lock: reject if already running
	if (activePipelines.has(name)) {
		return json({ error: `"${name}" is already running. Wait for it to finish or kill it.` }, { status: 409 });
	}

	// Detect chain vs pipeline
	const chainYamlPath = resolve(PIPELINES_DIR, name, 'chain.yaml');
	let isChain = false;
	try { await access(chainYamlPath); isChain = true; } catch { /* not a chain */ }

	const runId = crypto.randomUUID().slice(0, 8);
	const events: { stepId: string; status: string; detail?: string; time: string }[] = [];
	runEvents.set(runId, events);
	const outputBuffers = new Map<string, string[]>();
	stepOutputBuffers.set(runId, outputBuffers);

	const evictRun = () => {
		setTimeout(() => {
			runs.delete(runId);
			chainRuns.delete(runId);
			runEvents.delete(runId);
			stepOutputBuffers.delete(runId);
		}, 10 * 60 * 1000);
	};

	if (isChain) {
		// Chain run
		let parsedChain;
		try {
			parsedChain = await parseChain(chainYamlPath);
			const validation = validateChainRun(parsedChain, inputs || {});
			if (!validation.ok) {
				return json({ error: 'Validation failed', errors: validation.errors }, { status: 400 });
			}
		} catch (err) {
			return json({ error: `Chain parse failed: ${(err as Error).message}` }, { status: 400 });
		}

		if (inputs && Object.keys(inputs).length > 0) {
			saveInputs(name, inputs);
		}

		activePipelines.add(name);

		// Create a live chain run state that updates as nodes progress
		const liveChainRun = {
			runId,
			chainName: name,
			type: 'chain' as const,
			status: 'running' as string,
			startedAt: new Date().toISOString(),
			finishedAt: undefined as string | undefined,
			nodes: parsedChain.nodes.map(n => ({
				id: n.id,
				pipelineName: n.pipeline,
				status: 'pending' as string,
				attempt: 0,
				outputPath: undefined as string | undefined,
				error: undefined as string | undefined,
				durationMs: undefined as number | undefined,
				pipelineRun: undefined as PipelineRun | undefined,
			})),
			resolvedInputs: inputs || {},
		};
		chainRuns.set(runId, liveChainRun as ChainRun);

		const promise = runChain(
			chainYamlPath,
			inputs || {},
			(nodeId, status, detail) => {
				events.push({ stepId: `node:${nodeId}`, status, detail, time: new Date().toISOString() });
				// Update live chain run state
				const node = liveChainRun.nodes.find(n => n.id === nodeId);
				if (node) {
					node.status = status;
					if (status === 'failed' && detail) node.error = detail;
				}
			},
			(nodeId, stepId, status, detail) => {
				events.push({ stepId: `${nodeId}:${stepId}`, status, detail, time: new Date().toISOString() });
			},
			(nodeId, stepId, data) => {
				const key = `${nodeId}:${stepId}`;
				if (!outputBuffers.has(key)) outputBuffers.set(key, []);
				const buf = outputBuffers.get(key)!;
				buf.push(data);
				if (buf.length > 200) buf.shift();
			},
			runId,
			parsedChain,
		);

		promise.then((result) => {
			chainRuns.set(runId, result);
			activePipelines.delete(name);
			evictRun();
			recordManualRun({ runId, pipelineName: name, status: result.status, startedAt: result.startedAt, finishedAt: result.finishedAt, steps: [] });
		}).catch((err) => {
			const failedAt = new Date().toISOString();
			chainRuns.set(runId, {
				runId,
				chainName: name,
				type: 'chain',
				status: 'failed',
				startedAt: failedAt,
				finishedAt: failedAt,
				nodes: [],
				resolvedInputs: inputs || {},
			});
			events.push({ stepId: '_chain', status: 'failed', detail: (err as Error).message, time: new Date().toISOString() });
			activePipelines.delete(name);
			evictRun();
			recordManualRun({ runId, pipelineName: name, status: 'failed', startedAt: failedAt, finishedAt: failedAt, steps: [] });
		});

		return json({ runId, status: 'started', type: 'chain' });
	}

	// Pipeline run (existing logic)
	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');

	let parsedSpec;
	try {
		parsedSpec = await parsePipeline(yamlPath);
		const validation = validatePipelineRun(parsedSpec, inputs || {});
		if (!validation.ok) {
			return json({ error: 'Validation failed', errors: validation.errors }, { status: 400 });
		}
	} catch (err) {
		return json({ error: `Pipeline parse failed: ${(err as Error).message}` }, { status: 400 });
	}

	if (inputs && Object.keys(inputs).length > 0) {
		saveInputs(name, inputs);
	}

	activePipelines.add(name);

	const promise = runPipeline(
		yamlPath,
		inputs || {},
		(stepId, status, detail) => {
			events.push({ stepId, status, detail, time: new Date().toISOString() });
		},
		(stepId, data) => {
			if (!outputBuffers.has(stepId)) outputBuffers.set(stepId, []);
			const buf = outputBuffers.get(stepId)!;
			buf.push(data);
			if (buf.length > 200) buf.shift();
		},
		runId,
		resumeFrom,
		parsedSpec,
	);

	promise.then((result) => {
		const fullResult = { ...result, runId };
		runs.set(runId, fullResult);
		activePipelines.delete(name);
		evictRun();
		// Persist to run history
		recordManualRun({ runId, pipelineName: name, status: result.status, startedAt: result.startedAt, finishedAt: result.finishedAt, steps: result.steps });
	}).catch((err) => {
		const failedAt = new Date().toISOString();
		runs.set(runId, {
			runId,
			pipelineName: name,
			status: 'failed',
			startedAt: failedAt,
			finishedAt: failedAt,
			steps: [],
			resolvedInputs: inputs || {},
		});
		events.push({ stepId: '_pipeline', status: 'failed', detail: (err as Error).message, time: new Date().toISOString() });
		activePipelines.delete(name);
		evictRun();
		recordManualRun({ runId, pipelineName: name, status: 'failed', startedAt: failedAt, finishedAt: failedAt, steps: [] });
	});

	return json({ runId, status: 'started', type: 'pipeline' });
};

/** GET /api/pipelines/run?id=... — get run status */
export const GET: RequestHandler = async ({ url }) => {
	const runId = url.searchParams.get('id');

	// Return last run for a specific pipeline/chain name
	const lastName = url.searchParams.get('last');
	if (lastName) {
		// Search chain runs first
		for (const [id, cr] of chainRuns) {
			if (cr.chainName === lastName) {
				const events = runEvents.get(id) || [];
				const outputBuffers = stepOutputBuffers.get(id);
				const stepOutput: Record<string, string> = {};
				if (outputBuffers) {
					for (const [stepId, lines] of outputBuffers) {
						stepOutput[stepId] = lines.slice(-50).join('');
					}
				}
				return json({ ...cr, events, stepOutput });
			}
		}
		// Search pipeline runs
		for (const [id, pr] of runs) {
			if (pr.pipelineName === lastName) {
				const events = runEvents.get(id) || [];
				const outputBuffers = stepOutputBuffers.get(id);
				const stepOutput: Record<string, string> = {};
				if (outputBuffers) {
					for (const [stepId, lines] of outputBuffers) {
						stepOutput[stepId] = lines.slice(-50).join('');
					}
				}
				return json({ ...pr, events, stepOutput });
			}
		}
		return json({ error: 'No recent run found' }, { status: 404 });
	}

	if (!runId) {
		// Return all runs
		const allRuns = Array.from(runs.values()).sort(
			(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
		);
		return json({ runs: allRuns.slice(0, 20) });
	}

	const run = runs.get(runId);
	const chainRun = chainRuns.get(runId);
	const events = runEvents.get(runId) || [];
	const outputBuffers = stepOutputBuffers.get(runId);

	// Build step output map (last 50 lines per step for the response)
	const stepOutput: Record<string, string> = {};
	if (outputBuffers) {
		for (const [stepId, lines] of outputBuffers) {
			stepOutput[stepId] = lines.slice(-50).join('');
		}
	}

	if (chainRun) {
		return json({ ...chainRun, events, stepOutput });
	}

	if (!run) {
		if (events.length > 0) {
			return json({ runId, status: 'running', events, stepOutput });
		}
		return json({ error: 'Run not found' }, { status: 404 });
	}

	return json({ ...run, events, stepOutput });
};
