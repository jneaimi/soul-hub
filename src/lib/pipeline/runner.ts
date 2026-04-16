import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdir, stat, readFile, readdir, writeFile, unlink, copyFile, symlink, readlink, lstat } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { config } from '$lib/config.js';
import { spawnSession, writeInput, killSession as ptyKillSession } from '$lib/pty/manager.js';
import { parsePipeline, resolveRef, getExecutionOrder, checkCondition, evaluateCondition } from './parser.js';
import { parseChain } from './chain-parser.js';
import type { PipelineStep, PipelineMcp, PipelineRun, StepStatus } from './types.js';
import { sendViaChannel } from '$lib/channels/registry.js';
import { savePipelineOutput, savePipelineRunSummary } from '../vault/pipeline-bridge.js';

/**
 * Compute the run-scoped output directory name.
 * Format: {date}_{shortRunId} e.g. "2026-04-14_a8f3c1d2"
 */
function runScopedDir(runId: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return `${date}_${runId}`;
}

/**
 * Inject run scope into a relative output/ path.
 * "output/result.json" → "output/runs/{date}_{runId}/result.json"
 * Skips paths that already contain $RUN_ID, are absolute, /dev/null, or don't start with "output/".
 */
function injectRunScope(rawOutput: string, runId: string): string {
	if (!rawOutput || rawOutput === '/dev/null') return rawOutput;
	if (rawOutput.includes('$RUN_ID')) return rawOutput; // already versioned
	if (rawOutput.startsWith('/') || rawOutput.startsWith('~')) return rawOutput; // absolute
	if (!rawOutput.startsWith('output/') && !rawOutput.startsWith('output\\')) return rawOutput;
	// "output/result.json" → "output/runs/{scope}/result.json"
	const rest = rawOutput.slice('output/'.length);
	return `output/runs/${runScopedDir(runId)}/${rest}`;
}

/**
 * Update the output/latest symlink to point to the most recent run directory.
 * Non-blocking — failures are logged but don't break the pipeline.
 */
async function updateLatestSymlink(pipelineDir: string, runId: string): Promise<void> {
	const runsDir = join(pipelineDir, 'output', 'runs');
	const latestLink = join(pipelineDir, 'output', 'latest');
	const target = runScopedDir(runId);
	try {
		// Remove existing symlink (or file/dir at that path)
		try { await lstat(latestLink); await unlink(latestLink); } catch { /* doesn't exist */ }
		// Create relative symlink: output/latest → runs/{date}_{runId}
		await symlink(join('runs', target), latestLink);
	} catch (err) {
		console.warn(`[pipeline] Failed to update latest symlink:`, err instanceof Error ? err.message : err);
	}
}

/** MCP server configuration entry */
interface McpServerConfig {
	command?: string;
	args?: string[];
	url?: string;
	type?: string;
	env?: Record<string, string>;
}

/** MCP configuration file format */
interface McpJsonConfig {
	mcpServers: Record<string, McpServerConfig>;
}

const execFileAsync = promisify(execFile);

export type StepOutputCallback = (stepId: string, data: string) => void;
export type StepEventCallback = (stepId: string, status: StepStatus, detail?: string) => void;

/** Pending gate: a Promise that suspends the runner until the user acts */
interface PendingGate {
	resolve: (value: { action: 'approve' | 'answer'; value?: string }) => void;
	reject: (reason: Error) => void;
	stepId: string;
	type: 'approval' | 'prompt';
	timeout: ReturnType<typeof setTimeout>;
}

/** Active gates keyed by runId:stepId */
const pendingGates = new Map<string, PendingGate>();

/** Resolve a pending approval gate */
export function approveGate(runId: string, stepId: string): boolean {
	const key = `${runId}:${stepId}`;
	const gate = pendingGates.get(key);
	if (!gate) return false;
	clearTimeout(gate.timeout);
	gate.resolve({ action: 'approve' });
	pendingGates.delete(key);
	return true;
}

/** Reject a pending approval gate */
export function rejectGate(runId: string, stepId: string, reason?: string): boolean {
	const key = `${runId}:${stepId}`;
	const gate = pendingGates.get(key);
	if (!gate) return false;
	clearTimeout(gate.timeout);
	gate.reject(new Error(reason || 'Rejected by user'));
	pendingGates.delete(key);
	return true;
}

/** Answer a pending prompt gate */
export function answerGate(runId: string, stepId: string, value: string): boolean {
	const key = `${runId}:${stepId}`;
	const gate = pendingGates.get(key);
	if (!gate || gate.type !== 'prompt') return false;
	clearTimeout(gate.timeout);
	gate.resolve({ action: 'answer', value });
	pendingGates.delete(key);
	return true;
}

/** Build a temporary .mcp.json for pipeline agent steps.
 *  Merges inline mcp declarations with existing .mcp.json from pipeline dir or project. */
async function buildMcpConfig(
	mcpDeclarations: PipelineMcp[],
	pipelineDir: string,
	runDir: string,
): Promise<string | null> {
	if (!mcpDeclarations || mcpDeclarations.length === 0) return null;

	// Start with existing .mcp.json from pipeline dir (if any)
	let mcpJson: McpJsonConfig = { mcpServers: {} };
	try {
		const existing = await readFile(join(pipelineDir, '.mcp.json'), 'utf-8');
		mcpJson = JSON.parse(existing);
		if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
	} catch { /* no existing .mcp.json */ }

	// Merge declared MCP servers
	for (const mcp of mcpDeclarations) {
		if (mcp.command || mcp.url) {
			// Inline config — use as-is
			const cfg: McpServerConfig = {};
			if (mcp.command) cfg.command = mcp.command;
			if (mcp.args) cfg.args = mcp.args;
			if (mcp.url) { cfg.url = mcp.url; cfg.type = 'http'; }
			if (mcp.env) cfg.env = mcp.env;
			mcpJson.mcpServers[mcp.name] = cfg;
		} else {
			// Reference — look up from project .mcp.json files in ~/dev/
			if (mcpJson.mcpServers[mcp.name]) continue; // already present
			const found = await findMcpServer(mcp.name);
			if (found) mcpJson.mcpServers[mcp.name] = found;
		}
	}

	if (Object.keys(mcpJson.mcpServers).length === 0) return null;

	// Write to run dir so agent steps pick it up
	const mcpPath = join(runDir, '.mcp.json');
	await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2), 'utf-8');
	return mcpPath;
}

/** Cached MCP server registry: { servers, timestamp } */
let mcpRegistryCache: { servers: Map<string, McpServerConfig>; timestamp: number } | null = null;
const MCP_CACHE_TTL = 60_000; // 60 seconds

async function loadMcpRegistry(): Promise<Map<string, McpServerConfig>> {
	if (mcpRegistryCache && Date.now() - mcpRegistryCache.timestamp < MCP_CACHE_TTL) {
		return mcpRegistryCache.servers;
	}
	const servers = new Map<string, McpServerConfig>();
	try {
		const devDir = config.resolved.devDir;
		const projects = await readdir(devDir, { withFileTypes: true });
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			try {
				const raw = await readFile(join(devDir, project.name, '.mcp.json'), 'utf-8');
				const parsed = JSON.parse(raw);
				for (const [key, cfg] of Object.entries(parsed.mcpServers || {})) {
					servers.set(key.toLowerCase(), cfg as McpServerConfig);
				}
			} catch { /* skip */ }
		}
	} catch { /* devDir missing */ }
	mcpRegistryCache = { servers, timestamp: Date.now() };
	return servers;
}

/** Search ~/dev/ projects for an MCP server by name (case-insensitive) */
async function findMcpServer(name: string): Promise<McpServerConfig | null> {
	const registry = await loadMcpRegistry();
	return registry.get(name.toLowerCase()) || null;
}

/** System env vars always passed through (safe, needed for execution) */
const SYSTEM_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'USER', 'SHELL', 'TMPDIR'];

/** Build isolated env for pipeline step execution.
 *  Only passes: system essentials + declared pipeline env vars + pipeline-specific vars.
 *  Strips everything else (API keys, tokens, secrets).
 *  For block steps, adds BLOCK_CONFIG_* env vars from step config. */
function buildIsolatedEnv(
	spec: { env?: { name: string }[] },
	pipelineDir: string,
	inputPaths: string[],
	outputPath: string,
	stepConfig?: Record<string, unknown>,
): Record<string, string> {
	const env: Record<string, string> = {};

	// System essentials
	for (const key of SYSTEM_ENV_KEYS) {
		if (process.env[key]) env[key] = process.env[key]!;
	}

	// Claude binary needs to be on PATH
	env.PATH = `${dirname(config.resolved.claudeBinary)}:${env.PATH || ''}`;

	// Pipeline-specific vars
	env.PIPELINE_INPUT = inputPaths[0] || '';
	env.PIPELINE_OUTPUT = outputPath;
	env.PIPELINE_OUTPUT_DIR = dirname(outputPath);
	env.PIPELINE_DIR = pipelineDir;

	// Numbered inputs for multi-input steps
	for (let i = 0; i < inputPaths.length; i++) {
		env[`PIPELINE_INPUT_${i}`] = inputPaths[i];
	}
	env.PIPELINE_INPUT_COUNT = String(inputPaths.length);

	// Only pass env vars declared in the pipeline's env: section
	// Values come from the pipeline's .env file (TODO: Phase 8) or system env as fallback
	for (const declared of spec.env || []) {
		if (process.env[declared.name]) {
			env[declared.name] = process.env[declared.name]!;
		}
	}

	// Block config → BLOCK_CONFIG_* env vars
	if (stepConfig) {
		for (const [key, value] of Object.entries(stepConfig)) {
			const envKey = `BLOCK_CONFIG_${key.toUpperCase()}`;
			env[envKey] = Array.isArray(value) ? value.join(',') : String(value);
		}
	}

	return env;
}

/** Run a pipeline from a YAML file */
export async function runPipeline(
	yamlPath: string,
	inputOverrides: Record<string, string | number> = {},
	onStepEvent?: StepEventCallback,
	onStepOutput?: StepOutputCallback,
	externalRunId?: string,
	resumeFrom?: string,
	preSpec?: Awaited<ReturnType<typeof parsePipeline>>,
): Promise<PipelineRun> {
	const spec = preSpec || await parsePipeline(yamlPath);
	const pipelineDir = dirname(yamlPath);
	const runId = externalRunId || crypto.randomUUID().slice(0, 8);
	const runDir = join(tmpdir(), 'pipeline-runs', runId);
	await mkdir(runDir, { recursive: true });

	// Build MCP config for agent steps (if pipeline declares mcp servers)
	// Write to pipeline dir (not run dir) — agent cwd must be under ~/dev/ for trust
	const mcpConfigPath = await buildMcpConfig(spec.mcp || [], pipelineDir, pipelineDir);

	// Resolve inputs: defaults + overrides
	const resolvedInputs: Record<string, string | number> = {};
	for (const input of spec.inputs || []) {
		const val = inputOverrides[input.name] ?? input.default ?? '';
		// Resolve relative paths against pipeline directory
		if ((input.type === 'file' || input.type === 'path') && typeof val === 'string') {
			if (val.startsWith('./') || val.startsWith('../')) {
				resolvedInputs[input.name] = resolve(pipelineDir, val);
			} else if (val.startsWith('~/')) {
				resolvedInputs[input.name] = resolve(process.env.HOME || '', val.slice(2));
			} else {
				resolvedInputs[input.name] = val;
			}
		} else {
			resolvedInputs[input.name] = val;
		}
	}

	// Track step outputs for handoff resolution
	const stepOutputs: Record<string, string> = {};

	// Get execution order
	const order = getExecutionOrder(spec);
	const stepMap = new Map(spec.steps.map((s) => [s.id, s]));

	// Build run state
	const run: PipelineRun = {
		runId,
		pipelineName: spec.name,
		status: 'running',
		startedAt: new Date().toISOString(),
		steps: spec.steps.map((s) => ({
			id: s.id,
			status: 'pending' as StepStatus,
			attempt: 0,
		})),
		resolvedInputs,
	};

	const emit = (stepId: string, status: StepStatus, detail?: string) => {
		const sr = run.steps.find((s) => s.id === stepId);
		if (sr) {
			sr.status = status;
			if (status === 'running') sr.startedAt = new Date().toISOString();
			if (status === 'done' || status === 'failed') {
				sr.finishedAt = new Date().toISOString();
				sr.durationMs = new Date(sr.finishedAt).getTime() - new Date(sr.startedAt!).getTime();
			}
			if (detail && status === 'failed') sr.error = detail;
		}
		onStepEvent?.(stepId, status, detail);
	};

	// Resume mode: find the index to resume from
	let resumeReached = !resumeFrom; // if no resumeFrom, run everything

	// Execute steps in order
	for (const stepId of order) {
		const step = stepMap.get(stepId)!;

		// Resume logic: skip steps before resumeFrom if their output exists on disk
		if (!resumeReached) {
			if (stepId === resumeFrom) {
				resumeReached = true;
				// This step failed — run it again
			} else {
				// Check if this step's output file exists (from current or previous run)
				const today = new Date().toISOString().slice(0, 10);
				let rawResume = (step.output || '').replace('$RUN_ID', runId).replace('$DATE', today);
				rawResume = injectRunScope(rawResume, runId);
				let cachedOutput = resolveRef(rawResume, resolvedInputs, stepOutputs);
				if (cachedOutput && !cachedOutput.startsWith(tmpdir()) && cachedOutput !== '/dev/null') {
					if (!cachedOutput.startsWith('/')) cachedOutput = resolve(pipelineDir, cachedOutput);
					let found = false;
					try {
						await stat(cachedOutput);
						found = true;
					} catch {
						// Current run dir doesn't have it — check output/latest/ symlink
						const latestPath = cachedOutput.replace(`/runs/${runScopedDir(runId)}/`, '/latest/');
						if (latestPath !== cachedOutput) {
							try {
								await stat(latestPath);
								// Found in latest — copy into new run dir so downstream steps find it
								await mkdir(dirname(cachedOutput), { recursive: true });
								await copyFile(latestPath, cachedOutput);
								found = true;
							} catch { /* not there either */ }
						}
					}
					if (found) {
						stepOutputs[stepId] = cachedOutput;
						emit(stepId, 'done', 'Cached from previous run');
						const sr = run.steps.find((s) => s.id === stepId);
						if (sr) { sr.outputPath = cachedOutput; }
						continue;
					} else {
						resumeReached = true;
					}
				} else {
					// No output path or temp path — need to re-run
					resumeReached = true;
				}
			}
		}

		// Check when/skip_if conditions before executing
		const condition = checkCondition(step, resolvedInputs, stepOutputs);
		if (condition.skip) {
			emit(stepId, 'skipped', condition.reason);
			stepOutputs[stepId] = ''; // empty output for downstream refs
			continue;
		}

		const maxAttempts = (step.retry ?? 0) + 1;

		let success = false;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const sr = run.steps.find((s) => s.id === stepId)!;
			sr.attempt = attempt;

			emit(stepId, 'running', attempt > 1 ? `Retry ${attempt}/${maxAttempts}` : undefined);

			try {
				// Resolve output path (replace built-in variables and refs)
				const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
				let outputRaw = (step.output || '/dev/null').replace('$RUN_ID', runId).replace('$DATE', today);
				// Inject run scope: output/X → output/runs/{date}_{runId}/X
				outputRaw = injectRunScope(outputRaw, runId);
				let outputPath = resolveRef(outputRaw, resolvedInputs, stepOutputs);
				// Resolve relative output paths against the pipeline directory
				if (outputPath !== '/dev/null' && !outputPath.startsWith('/')) {
					outputPath = resolve(pipelineDir, outputPath);
				}

				// Resolve input(s)
				const inputs = Array.isArray(step.input) ? step.input : step.input ? [step.input] : [];
				const resolvedInputPaths = inputs.map((i) => resolveRef(i, resolvedInputs, stepOutputs));
				const primaryInput = resolvedInputPaths[0] || '';

				// Ensure output directory exists and clean stale output
				await mkdir(dirname(outputPath), { recursive: true });
				if (outputPath !== '/dev/null') {
					try { await unlink(outputPath); } catch { /* file may not exist */ }
				}

				// Resolve $inputs.* and $steps.* references in prompt, show, message, question
				const resolvedStep = { ...step };
				if (resolvedStep.prompt) {
					resolvedStep.prompt = resolveRef(resolvedStep.prompt, resolvedInputs, stepOutputs);
				}
				if (resolvedStep.show) {
					resolvedStep.show = resolveRef(resolvedStep.show, resolvedInputs, stepOutputs);
				}
				if (resolvedStep.message) {
					resolvedStep.message = resolveRef(resolvedStep.message, resolvedInputs, stepOutputs);
				}
				if (resolvedStep.question) {
					resolvedStep.question = resolveRef(resolvedStep.question, resolvedInputs, stepOutputs);
				}

				// Output callback for terminal streaming
				const outputCb = onStepOutput ? (data: string) => onStepOutput(stepId, data) : undefined;

				// Resolve $inputs.* / {{inputs.*}} references in step config values
				const resolvedConfig = step.config
					? Object.fromEntries(
						Object.entries(step.config).map(([k, v]) => [
							k,
							typeof v === 'string' ? resolveRef(v, resolvedInputs, stepOutputs) : v,
						]),
					)
					: undefined;

				// Build isolated env (only declared vars + system essentials + block config)
				const stepEnv = buildIsolatedEnv(spec, pipelineDir, resolvedInputPaths, outputPath, resolvedConfig);

				if (step.type === 'script') {
					await runScriptStep(resolvedStep, pipelineDir, primaryInput, outputPath, step.timeout ?? 300, outputCb, stepEnv);
				} else if (step.type === 'agent') {
					// For block-based agent steps, inject config into the prompt
					if (step.config && Object.keys(step.config).length > 0) {
						const configLines = Object.entries(step.config)
							.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
							.join('\n');
						resolvedStep.prompt = `## Block Config\n${configLines}\n\n${resolvedStep.prompt || ''}`;
					}
					await runAgentStep(resolvedStep, pipelineDir, primaryInput, outputPath, step.timeout ?? 300, outputCb, runId, stepEnv);
				} else if (step.type === 'approval' || step.type === 'prompt') {
					const gateResult = await runGateStep(resolvedStep, runId, step.timeout ?? 86400, emit, onStepOutput);
					// For prompt steps, store the answer as the step output reference
					if (gateResult.value !== undefined) {
						stepOutputs[stepId] = gateResult.value;
					}
				} else if (step.type === 'channel') {
					await runChannelStep(resolvedStep, resolvedInputs, stepOutputs, outputCb);
				} else if (step.type === 'chunk') {
					const chunkResult = await runChunkStep(resolvedStep, pipelineDir, resolvedInputs, stepOutputs, spec, outputCb, onStepEvent, runId);
					outputPath = chunkResult;
				} else if (step.type === 'loop') {
					await runLoopStep(resolvedStep, pipelineDir, resolvedInputs, stepOutputs, spec, outputCb, onStepEvent, runId);
				}

				// Verify output was produced (skip for action/webhook/approval/prompt/channel types)
				const outputType = step.output_type || 'file';
				if (step.type !== 'approval' && step.type !== 'prompt' && step.type !== 'channel' && (outputType === 'file' || outputType === 'media' || outputType === 'response')) {
					try {
						await stat(outputPath);
					} catch {
						throw new Error(`Step "${stepId}" did not produce expected output at ${outputPath}`);
					}
				}

				// For prompt steps, the answer is already in stepOutputs — don't overwrite
				// For approval steps, there's no meaningful output
				if (step.type !== 'prompt' && step.type !== 'approval' && step.type !== 'channel') {
					stepOutputs[stepId] = outputPath;
					sr.outputPath = outputPath;
					sr.outputType = step.output_type || 'file';
				}
				emit(stepId, 'done');

				// Save to vault (non-blocking, but capture note path when it resolves)
				if (outputPath && outputPath !== '/dev/null') {
					savePipelineOutput({
						pipelineName: spec.name,
						runId,
						stepId,
						stepType: step.type,
						outputPath,
						outputType: step.output_type,
						vaultZone: step.vault_zone,
					}).then((notePath) => {
						if (notePath) {
							const sr = run.steps.find(s => s.id === stepId);
							if (sr) sr.vaultNotePath = notePath;
						}
					}).catch((err) => console.warn(`[vault] Failed to save output for ${stepId}:`, err?.message ?? err));
				}

				success = true;
				break;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (attempt === maxAttempts) {
					emit(stepId, 'failed', msg);
				}
			}
		}

		if (!success) {
			const strategy = spec.on_failure?.strategy ?? 'halt';
			if (strategy === 'halt') {
				run.status = 'failed';
				// Mark remaining steps as skipped
				for (const remaining of order.slice(order.indexOf(stepId) + 1)) {
					emit(remaining, 'skipped');
				}
				break;
			} else if (strategy === 'skip') {
				// Continue to next step, but mark this one failed
				stepOutputs[stepId] = ''; // empty output for downstream refs
			}
		}
	}

	if (run.status !== 'failed') {
		run.status = 'done';
	}
	run.finishedAt = new Date().toISOString();

	// Update output/latest symlink (non-blocking, best-effort)
	updateLatestSymlink(pipelineDir, runId).catch(() => {});

	// Save pipeline run summary to vault (non-blocking)
	if (run.status === 'done' || run.status === 'failed') {
		savePipelineRunSummary({
			pipelineName: spec.name,
			runId,
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			steps: run.steps.map(s => ({
				id: s.id,
				status: s.status,
				durationMs: s.durationMs,
				error: s.error,
				outputPath: s.outputPath,
			})),
			resolvedInputs: run.resolvedInputs,
		}).catch((err) => console.warn(`[vault] Failed to save run summary for ${spec.name}:`, err?.message ?? err));
	}

	// Clean up temp .mcp.json from pipeline dir (written by buildMcpConfig)
	if (mcpConfigPath) {
		try { await unlink(mcpConfigPath); } catch { /* already gone */ }
	}

	return run;
}

/** Execute an approval or prompt step — suspends until user acts or timeout */
async function runGateStep(
	step: PipelineStep,
	runId: string,
	timeoutSec: number,
	emit: (stepId: string, status: StepStatus, detail?: string) => void,
	onStepOutput?: StepOutputCallback,
): Promise<{ action: string; value?: string }> {
	const key = `${runId}:${step.id}`;

	// Emit waiting status with context
	const detail = step.type === 'approval'
		? step.message || 'Waiting for approval'
		: step.question || 'Waiting for input';
	emit(step.id, 'waiting', detail);

	// Send gate info as output so the UI can render it
	const gateInfo = JSON.stringify({
		_gate: true,
		type: step.type,
		message: step.message,
		question: step.question,
		show: step.show,
		options: step.options,
		options_from: step.options_from,
	});
	onStepOutput?.(step.id, gateInfo);

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingGates.delete(key);
			reject(new Error(`${step.type} step "${step.id}" timed out after ${timeoutSec}s`));
		}, timeoutSec * 1000);

		pendingGates.set(key, {
			resolve,
			reject,
			stepId: step.id,
			type: step.type as 'approval' | 'prompt',
			timeout,
		});
	});
}

function splitCommand(cmd: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuote = '';
	for (const char of cmd) {
		if (inQuote) {
			if (char === inQuote) { inQuote = ''; }
			else { current += char; }
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) { result.push(current); current = ''; }
		} else {
			current += char;
		}
	}
	if (current) result.push(current);
	return result;
}

/** Execute a script step via child_process */
async function runScriptStep(
	step: PipelineStep,
	pipelineDir: string,
	inputPath: string,
	outputPath: string,
	timeoutSec: number,
	onOutput?: (data: string) => void,
	env?: Record<string, string>,
): Promise<void> {
	const [cmd, ...args] = splitCommand(step.run!);

	// If the command references a relative script, resolve against pipeline dir
	const resolvedArgs = args.map((a) => {
		if (a.endsWith('.py') || a.endsWith('.sh') || a.endsWith('.js')) {
			return resolve(pipelineDir, a);
		}
		return a;
	});

	// Pass input path as first argument
	if (inputPath) resolvedArgs.push(inputPath);

	try {
		const { stdout, stderr } = await execFileAsync(cmd, resolvedArgs, {
			cwd: pipelineDir,
			timeout: timeoutSec * 1000,
			maxBuffer: 5 * 1024 * 1024,
			env: env || process.env,
		});

		if (stderr) {
			console.error(`[pipeline:${step.id}] stderr: ${stderr.trim()}`);
			onOutput?.(stderr);
		}
		if (stdout) {
			console.log(`[pipeline:${step.id}] ${stdout.trim()}`);
			onOutput?.(stdout);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes('maxBuffer')) {
			throw new Error(`Step "${step.id}" exceeded 5MB output buffer limit. The script produced too much output.`);
		}
		throw err;
	}
}

// Track active PTY sessions for pipeline steps (enables interaction)
const activePtySessions = new Map<string, string>(); // stepId → sessionId

// Track which sessions belong to which run (for kill)
const runSessions = new Map<string, Set<string>>();

/** Kill all active PTY sessions for a pipeline run and reject pending gates */
export function killPipeline(runId: string): boolean {
	let killed = false;

	// Kill PTY sessions
	const sessionKeys = runSessions.get(runId);
	if (sessionKeys && sessionKeys.size > 0) {
		for (const stepId of sessionKeys) {
			const sessionId = activePtySessions.get(stepId);
			if (sessionId) {
				ptyKillSession(sessionId);
				activePtySessions.delete(stepId);
			}
		}
		runSessions.delete(runId);
		killed = true;
	}

	// Reject any pending gates for this run
	for (const [key, gate] of pendingGates) {
		if (key.startsWith(`${runId}:`)) {
			clearTimeout(gate.timeout);
			gate.reject(new Error('Pipeline killed'));
			pendingGates.delete(key);
			killed = true;
		}
	}

	return killed;
}

/** Execute an agent step via shared PTY manager (same mechanism as interactive terminals) */
async function runAgentStep(
	step: PipelineStep,
	pipelineDir: string,
	inputPath: string,
	outputPath: string,
	timeoutSec: number,
	onOutput?: (data: string) => void,
	runId?: string,
	env?: Record<string, string>,
): Promise<void> {
	// Build the prompt for Claude — injected into the PTY after status bar appears
	let prompt = step.prompt || '';
	if (inputPath) {
		prompt += `\n\nInput file: ${inputPath}\nRead this file first.`;
	}
	prompt += `\n\nWrite your output to: ${outputPath}`;
	prompt += `\n\nIMPORTANT: When you have finished writing the output file, type /exit to end the session.`;

	// Extract model from agent.md frontmatter (if block-based)
	let model = '';
	if (step.agent) {
		try {
			const agentPath = resolve(pipelineDir, step.agent);
			const agentContent = await readFile(agentPath, 'utf-8');
			const modelMatch = agentContent.match(/^model:\s*(\S+)/m);
			if (modelMatch) model = modelMatch[1];
		} catch { /* use default model */ }
	}

	const session = spawnSession({
		prompt,
		cwd: pipelineDir,
		cols: config.terminal.cols,
		rows: config.terminal.rows,
		model: model || undefined,
		env,
	});

	// Track for interaction + kill
	activePtySessions.set(step.id, session.id);
	if (runId) {
		if (!runSessions.has(runId)) runSessions.set(runId, new Set());
		runSessions.get(runId)!.add(step.id);
	}

	return new Promise((resolvePromise, reject) => {
		let resolved = false;

		// Timeout guard
		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				clearInterval(watchdog);
				ptyKillSession(session.id);
				activePtySessions.delete(step.id);
				reject(new Error(`Agent step "${step.id}" timed out after ${timeoutSec}s`));
			}
		}, timeoutSec * 1000);

		// Watchdog: poll for output file — if Claude wrote it but didn't exit, send /exit
		let exitSent = false;
		const watchdog = setInterval(async () => {
			if (resolved || exitSent) { clearInterval(watchdog); return; }
			try {
				await stat(outputPath);
				exitSent = true;
				clearInterval(watchdog);
				setTimeout(() => {
					if (!resolved) {
						console.log(`[pipeline:${step.id}] Output file detected, sending /exit`);
						writeInput(session.id, '/exit\r');
					}
				}, 3000);
			} catch { /* file doesn't exist yet */ }
		}, 5000);

		session.emitter.on('output', (data: string) => {
			onOutput?.(data);
		});

		session.emitter.on('exit', (code: number) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			clearInterval(watchdog);
			activePtySessions.delete(step.id);

			// Exit code 0 = clean exit, -1 or other = PTY closed (normal for /exit command)
			// Accept 0 and -1 as success if the output file was produced
			if (code === 0 || code === -1) {
				resolvePromise();
			} else {
				reject(new Error(`Agent step "${step.id}" exited with code ${code}`));
			}
		});
	});
}

/** Execute a chunk step — process a directory of files in parallel batches */
async function runChunkStep(
	step: PipelineStep,
	pipelineDir: string,
	resolvedInputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
	spec: { env?: { name: string }[] },
	onOutput?: (data: string) => void,
	onEvent?: StepEventCallback,
	runId?: string,
): Promise<string> {
	const inputDir = resolveRef(step.input as string, resolvedInputs, stepOutputs);

	const inputStat = await stat(inputDir);
	if (!inputStat.isDirectory()) {
		throw new Error(`Chunk step "${step.id}" expects a directory as input, got a file: ${inputDir}`);
	}

	const chunkFiles = (await readdir(inputDir))
		.filter(f => !f.startsWith('.'))
		.sort();

	if (chunkFiles.length === 0) {
		onEvent?.(step.id, 'skipped', 'No chunks to process');
		return step.output!;
	}
	const maxChunks = step.max_chunks ?? 500;
	if (chunkFiles.length > maxChunks) {
		throw new Error(`Chunk step "${step.id}": ${chunkFiles.length} chunks exceeds max_chunks (${maxChunks}). Increase chunk size.`);
	}

	const outputDir = resolve(pipelineDir, step.output!);
	await mkdir(outputDir, { recursive: true });

	const parallel = Math.min(step.parallel ?? 1, step.run ? 10 : 5);
	const totalTimeout = (step.total_timeout ?? 1800) * 1000;
	const startTime = Date.now();
	let completed = 0;
	let failed = 0;

	for (let i = 0; i < chunkFiles.length; i += parallel) {
		if (Date.now() - startTime > totalTimeout) {
			throw new Error(`Chunk step "${step.id}" exceeded total timeout (${step.total_timeout ?? 1800}s)`);
		}

		const batch = chunkFiles.slice(i, i + parallel);
		const results = await Promise.allSettled(
			batch.map(async (chunkFile, batchIdx) => {
				const chunkIdx = i + batchIdx;
				const chunkInputPath = join(inputDir, chunkFile);
				const chunkOutputPath = join(outputDir, `${String(chunkIdx).padStart(3, '0')}_${chunkFile}`);

				const chunkEnv = buildIsolatedEnv(spec, pipelineDir, [chunkInputPath], chunkOutputPath, step.config);

				if (step.run) {
					await runScriptStep({ ...step, output: chunkOutputPath }, pipelineDir, chunkInputPath, chunkOutputPath, step.timeout ?? 300, onOutput, chunkEnv);
				} else if (step.agent) {
					await runAgentStep({ ...step, output: chunkOutputPath }, pipelineDir, chunkInputPath, chunkOutputPath, step.timeout ?? 300, onOutput, runId, chunkEnv);
				}
				return chunkOutputPath;
			})
		);

		for (const r of results) {
			if (r.status === 'fulfilled') {
				completed++;
			} else {
				failed++;
				const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
				onOutput?.(`Chunk failed: ${msg}\n`);
				if ((step.chunk_on_failure ?? 'halt') === 'halt') {
					throw new Error(`Chunk step "${step.id}": chunk failed (${completed}/${chunkFiles.length} completed). Error: ${msg}`);
				}
			}
		}

		onOutput?.(`Chunks: ${completed}/${chunkFiles.length} done${failed > 0 ? `, ${failed} failed` : ''}\n`);
	}

	const merge = step.merge ?? 'skip';
	if (merge !== 'skip' && step.merge_output) {
		const mergeOutputPath = resolve(pipelineDir, step.merge_output);
		await mkdir(dirname(mergeOutputPath), { recursive: true });

		const outputFiles = (await readdir(outputDir)).filter(f => !f.startsWith('.')).sort();

		if (merge === 'concat') {
			const contents: string[] = [];
			for (const f of outputFiles) {
				contents.push(await readFile(join(outputDir, f), 'utf-8'));
			}
			await writeFile(mergeOutputPath, contents.join('\n'), 'utf-8');
		} else if (merge === 'json-array') {
			const items: unknown[] = [];
			for (const f of outputFiles) {
				const content = await readFile(join(outputDir, f), 'utf-8');
				try {
					items.push(JSON.parse(content));
				} catch {
					onOutput?.(`Warning: chunk "${f}" produced invalid JSON, included as error placeholder\n`);
					items.push({ _file: f, _error: 'Invalid JSON', _raw: content.slice(0, 500) });
				}
			}
			await writeFile(mergeOutputPath, JSON.stringify(items, null, 2), 'utf-8');
		}

		return mergeOutputPath;
	}

	return outputDir;
}

/** Execute a loop step — repeat block execution until condition met or max iterations */
async function runLoopStep(
	step: PipelineStep,
	pipelineDir: string,
	resolvedInputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
	spec: { env?: { name: string }[] },
	onOutput?: (data: string) => void,
	onEvent?: StepEventCallback,
	runId?: string,
): Promise<void> {
	const maxIterations = step.max_iterations ?? 3;
	const totalTimeout = (step.total_timeout ?? 900) * 1000;
	const startTime = Date.now();
	const outputPath = resolve(pipelineDir, step.output!);

	let currentInput = '';
	if (step.input) {
		const inputs = Array.isArray(step.input) ? step.input : [step.input];
		currentInput = resolveRef(inputs[0], resolvedInputs, stepOutputs);
	}

	let conditionBroken = false;
	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		if (Date.now() - startTime > totalTimeout) {
			onOutput?.(`Loop reached total timeout after ${iteration - 1} iterations\n`);
			break;
		}

		onOutput?.(`Loop iteration ${iteration}/${maxIterations}\n`);

		if (iteration > 1) {
			const tempInput = join(tmpdir(), `loop-${step.id}-iter${iteration}-input`);
			await copyFile(outputPath, tempInput);
			currentInput = tempInput;
		}

		try { await unlink(outputPath); } catch { /* may not exist */ }
		await mkdir(dirname(outputPath), { recursive: true });

		const loopEnv = buildIsolatedEnv(spec, pipelineDir, [currentInput], outputPath, step.config);

		if (step.run) {
			await runScriptStep({ ...step }, pipelineDir, currentInput, outputPath, step.timeout ?? 300, onOutput, loopEnv);
		} else if (step.agent) {
			await runAgentStep({ ...step }, pipelineDir, currentInput, outputPath, step.timeout ?? 300, onOutput, runId, loopEnv);
		}

		stepOutputs[step.id] = outputPath;

		if (step.until && !conditionBroken) {
			try {
				const outputContent = await readFile(outputPath, 'utf-8');
				const result = evaluateCondition(
					step.until,
					resolvedInputs,
					{ ...stepOutputs, [step.id]: outputContent },
				);
				if (result) {
					onOutput?.(`Loop condition met at iteration ${iteration}\n`);
					return;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				onOutput?.(`Warning: loop condition failed — ${msg}. Remaining iterations will ignore the condition.\n`);
				conditionBroken = true;
			}
		}
	}

	onOutput?.(`Loop completed after ${maxIterations} iterations (condition not met — using last output)\n`);
}

/** Execute a channel step — send a message via a configured channel adapter */
async function runChannelStep(
	step: PipelineStep,
	resolvedInputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
	onOutput?: (data: string) => void,
): Promise<void> {
	const message = step.message || '';
	if (!message) {
		throw new Error(`Channel step "${step.id}" has no message`);
	}

	// Resolve attach path if present
	let attachPath: string | undefined;
	if (step.attach) {
		attachPath = resolveRef(step.attach, resolvedInputs, stepOutputs);
	}

	const result = await sendViaChannel(
		step.channel,
		config.channels,
		message,
		attachPath,
	);

	if (!result.ok) {
		throw new Error(`Channel send failed: ${result.error}`);
	}

	onOutput?.(`Channel "${step.channel || 'default'}": message sent (id: ${result.messageId || 'n/a'})\n`);
}

/** Send input to a running pipeline step's PTY (for interaction) */
export function sendInputToStep(stepId: string, data: string): boolean {
	const sessionId = activePtySessions.get(stepId);
	if (!sessionId) return false;
	return writeInput(sessionId, data);
}

/** Pipeline list cache: keyed by dir entry name → { spec summary, yamlMtime } */
const pipelineListCache = new Map<string, { name: string; path: string; description: string; type: 'pipeline' | 'chain'; mtime: number }>();
let pipelineListCacheDir = '';

/** List available pipelines and chains from the pipelines directory */
export async function listPipelines(pipelinesDir: string): Promise<{ name: string; path: string; description: string; type: 'pipeline' | 'chain' }[]> {
	const results: { name: string; path: string; description: string; type: 'pipeline' | 'chain' }[] = [];

	// Invalidate cache if directory changed
	if (pipelinesDir !== pipelineListCacheDir) {
		pipelineListCache.clear();
		pipelineListCacheDir = pipelinesDir;
	}

	try {
		const entries = await readdir(pipelinesDir, { withFileTypes: true });
		const currentDirs = new Set<string>();

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
			currentDirs.add(entry.name);

			// Try pipeline.yaml first
			const pipelineYamlPath = join(pipelinesDir, entry.name, 'pipeline.yaml');
			let found = false;

			try {
				const yamlStat = await stat(pipelineYamlPath);
				const mtime = yamlStat.mtimeMs;
				const cached = pipelineListCache.get(entry.name);

				if (cached && cached.mtime === mtime) {
					results.push({ name: cached.name, path: cached.path, description: cached.description, type: cached.type });
					found = true;
				} else {
					const spec = await parsePipeline(pipelineYamlPath);
					const item = { name: spec.name, path: pipelineYamlPath, description: spec.description || '', type: 'pipeline' as const };
					pipelineListCache.set(entry.name, { ...item, mtime });
					results.push(item);
					found = true;
				}
			} catch {
				// No valid pipeline.yaml
			}

			// If no pipeline.yaml, try chain.yaml
			if (!found) {
				const chainYamlPath = join(pipelinesDir, entry.name, 'chain.yaml');
				try {
					const yamlStat = await stat(chainYamlPath);
					const mtime = yamlStat.mtimeMs;
					const cached = pipelineListCache.get(entry.name);

					if (cached && cached.mtime === mtime) {
						results.push({ name: cached.name, path: cached.path, description: cached.description, type: cached.type });
					} else {
						const spec = await parseChain(chainYamlPath);
						const item = { name: spec.name, path: chainYamlPath, description: spec.description || '', type: 'chain' as const };
						pipelineListCache.set(entry.name, { ...item, mtime });
						results.push(item);
					}
				} catch {
					// Skip — neither pipeline.yaml nor chain.yaml
					pipelineListCache.delete(entry.name);
				}
			}
		}

		// Remove stale cache entries for deleted directories
		for (const key of pipelineListCache.keys()) {
			if (!currentDirs.has(key)) pipelineListCache.delete(key);
		}
	} catch {
		// pipelines directory doesn't exist
	}

	return results;
}

/** Find all chains that reference a given pipeline by name */
export async function findChainReferences(pipelineName: string): Promise<string[]> {
	const pipDir = config.resolved.pipelinesDir || join(config.resolved.devDir, 'soul-hub', 'pipelines');
	const refs: string[] = [];
	try {
		const entries = await readdir(pipDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
			const chainPath = join(pipDir, entry.name, 'chain.yaml');
			try {
				const raw = await readFile(chainPath, 'utf-8');
				if (raw.includes(`pipeline: ${pipelineName}`) || raw.includes(`pipeline: "${pipelineName}"`)) {
					refs.push(entry.name);
				}
			} catch { /* no chain.yaml */ }
		}
	} catch { /* pipelines dir missing */ }
	return refs;
}
