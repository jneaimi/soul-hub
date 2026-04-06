import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { config } from '$lib/config.js';
import { parsePipeline, resolveRef, getExecutionOrder } from './parser.js';
import type { PipelineStep, PipelineRun, StepStatus } from './types.js';

const execFileAsync = promisify(execFile);

const BRIDGE_SCRIPT = resolve(dirname(config.resolved.marketplaceDir), 'scripts', 'pty_bridge.py');

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

/** Get info about a pending gate (for UI) */
export function getGateInfo(runId: string, stepId: string): { type: 'approval' | 'prompt' } | null {
	const gate = pendingGates.get(`${runId}:${stepId}`);
	return gate ? { type: gate.type } : null;
}

/** System env vars always passed through (safe, needed for execution) */
const SYSTEM_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'USER', 'SHELL', 'TMPDIR'];

/** Build isolated env for pipeline step execution.
 *  Only passes: system essentials + declared pipeline env vars + pipeline-specific vars.
 *  Strips everything else (API keys, tokens, secrets). */
function buildIsolatedEnv(
	spec: { env?: { name: string }[] },
	pipelineDir: string,
	inputPaths: string[],
	outputPath: string,
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

	return env;
}

/** Run a pipeline from a YAML file */
export async function runPipeline(
	yamlPath: string,
	inputOverrides: Record<string, string | number> = {},
	onStepEvent?: StepEventCallback,
	onStepOutput?: StepOutputCallback,
	externalRunId?: string,
): Promise<PipelineRun> {
	const spec = await parsePipeline(yamlPath);
	const pipelineDir = dirname(yamlPath);
	const runId = externalRunId || crypto.randomUUID().slice(0, 8);
	const runDir = `/tmp/pipeline-runs/${runId}`;
	await mkdir(runDir, { recursive: true });

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

	// Execute steps in order
	for (const stepId of order) {
		const step = stepMap.get(stepId)!;
		const maxAttempts = (step.retry ?? 0) + 1;

		let success = false;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const sr = run.steps.find((s) => s.id === stepId)!;
			sr.attempt = attempt;

			emit(stepId, 'running', attempt > 1 ? `Retry ${attempt}/${maxAttempts}` : undefined);

			try {
				// Resolve output path (replace built-in variables and refs)
				const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
				let outputPath = step.output.replace('$RUN_ID', runId).replace('$DATE', today);
				outputPath = resolveRef(outputPath, resolvedInputs, stepOutputs);

				// Resolve input(s)
				const inputs = Array.isArray(step.input) ? step.input : step.input ? [step.input] : [];
				const resolvedInputPaths = inputs.map((i) => resolveRef(i, resolvedInputs, stepOutputs));
				const primaryInput = resolvedInputPaths[0] || '';

				// Ensure output directory exists
				await mkdir(dirname(outputPath), { recursive: true });

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

				// Build isolated env (only declared vars + system essentials)
				const stepEnv = buildIsolatedEnv(spec, pipelineDir, resolvedInputPaths, outputPath);

				if (step.type === 'script') {
					await runScriptStep(resolvedStep, pipelineDir, primaryInput, outputPath, step.timeout ?? 300, outputCb, stepEnv);
				} else if (step.type === 'agent') {
					await runAgentStep(resolvedStep, pipelineDir, primaryInput, outputPath, step.timeout ?? 300, outputCb, runId, stepEnv);
				} else if (step.type === 'approval' || step.type === 'prompt') {
					const gateResult = await runGateStep(resolvedStep, runId, step.timeout ?? 86400, emit, onStepOutput);
					// For prompt steps, store the answer as the step output reference
					if (gateResult.value !== undefined) {
						stepOutputs[stepId] = gateResult.value;
					}
				}

				// Verify output was produced (skip for action/webhook/approval/prompt types)
				const outputType = step.output_type || 'file';
				if (step.type !== 'approval' && step.type !== 'prompt' && (outputType === 'file' || outputType === 'media' || outputType === 'response')) {
					try {
						await stat(outputPath);
					} catch {
						throw new Error(`Step "${stepId}" did not produce expected output at ${outputPath}`);
					}
				}

				// For prompt steps, the answer is already in stepOutputs — don't overwrite
				// For approval steps, there's no meaningful output
				if (step.type !== 'prompt' && step.type !== 'approval') {
					stepOutputs[stepId] = outputPath;
					sr.outputPath = outputPath;
					sr.outputType = step.output_type || 'file';
				}
				emit(stepId, 'done');
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
	const [cmd, ...args] = step.run!.split(/\s+/);

	// If the command references a relative script, resolve against pipeline dir
	const resolvedArgs = args.map((a) => {
		if (a.endsWith('.py') || a.endsWith('.sh') || a.endsWith('.js')) {
			return resolve(pipelineDir, a);
		}
		return a;
	});

	// Pass input path as first argument
	if (inputPath) resolvedArgs.push(inputPath);

	const { stdout, stderr } = await execFileAsync(cmd, resolvedArgs, {
		cwd: pipelineDir,
		timeout: timeoutSec * 1000,
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
}

// Track active PTY sessions for pipeline steps (enables interaction)
const activePtyBridges = new Map<string, import('node:child_process').ChildProcess>();

// Track which bridges belong to which run (for kill)
const runBridges = new Map<string, Set<string>>();

/** Kill all active PTY bridges for a pipeline run and reject pending gates */
export function killPipeline(runId: string): boolean {
	let killed = false;

	// Kill PTY bridges
	const bridgeKeys = runBridges.get(runId);
	if (bridgeKeys && bridgeKeys.size > 0) {
		for (const key of bridgeKeys) {
			const bridge = activePtyBridges.get(key);
			if (bridge) {
				bridge.stdin?.write(JSON.stringify({ type: 'kill' }) + '\n');
				bridge.kill();
				activePtyBridges.delete(key);
			}
		}
		runBridges.delete(runId);
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

/** Get an active PTY bridge for a step (for sending input/interaction) */
export function getStepBridge(runStepKey: string) {
	return activePtyBridges.get(runStepKey);
}

/** Execute an agent step via pty_bridge.py (same PTY as interactive terminals) */
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

	const bridgeArgs = JSON.stringify({
		prompt,
		cwd: pipelineDir,
		cols: config.terminal.cols,
		rows: config.terminal.rows,
		claudeBinary: config.resolved.claudeBinary,
	});

	return new Promise((resolvePromise, reject) => {
		const bridge = spawn('python3', [BRIDGE_SCRIPT, bridgeArgs], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: env || process.env,
		});

		// Track for interaction + kill
		const bridgeKey = `${step.id}`;
		activePtyBridges.set(bridgeKey, bridge);
		if (runId) {
			if (!runBridges.has(runId)) runBridges.set(runId, new Set());
			runBridges.get(runId)!.add(bridgeKey);
		}

		const rl = createInterface({ input: bridge.stdout! });

		// Timeout guard
		const timer = setTimeout(() => {
			bridge.stdin?.write(JSON.stringify({ type: 'kill' }) + '\n');
			bridge.kill();
			activePtyBridges.delete(bridgeKey);
			reject(new Error(`Agent step "${step.id}" timed out after ${timeoutSec}s`));
		}, timeoutSec * 1000);

		// Watchdog: poll for output file — if Claude wrote it but didn't exit, send /exit
		let resolved = false;
		const watchdog = setInterval(async () => {
			if (resolved) { clearInterval(watchdog); return; }
			try {
				await stat(outputPath);
				// Output file exists — wait 3s for Claude to exit naturally, then force /exit
				setTimeout(() => {
					if (!resolved && bridge.stdin?.writable) {
						console.log(`[pipeline:${step.id}] Output file detected, sending /exit`);
						bridge.stdin.write(JSON.stringify({ type: 'input', data: '/exit\r' }) + '\n');
					}
				}, 3000);
				clearInterval(watchdog);
			} catch { /* file doesn't exist yet */ }
		}, 5000);

		rl.on('line', (line) => {
			try {
				const msg = JSON.parse(line);
				if (msg.type === 'output') {
					onOutput?.(msg.data);
				} else if (msg.type === 'exit') {
					resolved = true;
					clearTimeout(timer);
					clearInterval(watchdog);
					rl.close();
					activePtyBridges.delete(bridgeKey);
					// Exit code 0 = clean exit, -1 = PTY closed (normal for /exit command)
					// Accept both as success if the output file was produced
					if (msg.code === 0 || msg.code === -1) {
						resolvePromise();
					} else {
						reject(new Error(`Agent step "${step.id}" exited with code ${msg.code}`));
					}
				}
			} catch { /* skip non-JSON */ }
		});

		bridge.stderr!.on('data', (data) => {
			console.error(`[pipeline:${step.id}] ${data.toString().trim()}`);
		});

		bridge.on('error', (err) => {
			resolved = true;
			clearTimeout(timer);
			clearInterval(watchdog);
			activePtyBridges.delete(bridgeKey);
			reject(new Error(`Agent step "${step.id}" failed to spawn: ${err.message}`));
		});

		bridge.on('exit', () => {
			resolved = true;
			clearTimeout(timer);
			clearInterval(watchdog);
			activePtyBridges.delete(bridgeKey);
		});
	});
}

/** Send input to a running pipeline step's PTY (for interaction) */
export function sendInputToStep(stepId: string, data: string): boolean {
	const bridge = activePtyBridges.get(stepId);
	if (!bridge?.stdin?.writable) return false;
	bridge.stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
	return true;
}

/** List available pipelines from the pipelines directory */
export async function listPipelines(pipelinesDir: string): Promise<{ name: string; path: string; description: string }[]> {
	const { readdir } = await import('node:fs/promises');
	const results: { name: string; path: string; description: string }[] = [];

	try {
		const entries = await readdir(pipelinesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const yamlPath = join(pipelinesDir, entry.name, 'pipeline.yaml');
			try {
				const spec = await parsePipeline(yamlPath);
				results.push({
					name: spec.name,
					path: yamlPath,
					description: spec.description || '',
				});
			} catch {
				// Skip invalid pipelines
			}
		}
	} catch {
		// pipelines directory doesn't exist
	}

	return results;
}
