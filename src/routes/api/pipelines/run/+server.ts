import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { runPipeline, sendInputToStep, killPipeline } from '$lib/pipeline/index.js';
import type { PipelineRun } from '$lib/pipeline/types.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.marketplaceDir), 'pipelines');

// Track active and completed runs
const runs = new Map<string, PipelineRun>();
const runEvents = new Map<string, { stepId: string; status: string; detail?: string; time: string }[]>();

// Track terminal output per step (ring buffer — last 200 lines per step)
const stepOutputBuffers = new Map<string, Map<string, string[]>>();

// Concurrency lock: one active run per pipeline name
const activePipelines = new Set<string>();

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

	// Handle kill: abort a running pipeline
	if (body.action === 'kill') {
		const { runId } = body;
		if (!runId) return json({ error: 'Missing runId' }, { status: 400 });
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
		return json({ ok: killed });
	}

	const { name, inputs } = body as { name: string; inputs?: Record<string, string | number> };

	if (!name) {
		return json({ error: 'Missing pipeline name' }, { status: 400 });
	}

	// Concurrency lock: reject if already running
	if (activePipelines.has(name)) {
		return json({ error: `Pipeline "${name}" is already running. Wait for it to finish or kill it.` }, { status: 409 });
	}

	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');

	// Run pipeline asynchronously — return run ID immediately
	const runId = crypto.randomUUID().slice(0, 8);
	const events: { stepId: string; status: string; detail?: string; time: string }[] = [];
	runEvents.set(runId, events);

	// Terminal output buffers per step
	const outputBuffers = new Map<string, string[]>();
	stepOutputBuffers.set(runId, outputBuffers);

	// Acquire concurrency lock
	activePipelines.add(name);

	// Start pipeline in background
	const promise = runPipeline(
		yamlPath,
		inputs || {},
		(stepId, status, detail) => {
			events.push({ stepId, status, detail, time: new Date().toISOString() });
		},
		(stepId, data) => {
			// Capture terminal output per step (ring buffer)
			if (!outputBuffers.has(stepId)) outputBuffers.set(stepId, []);
			const buf = outputBuffers.get(stepId)!;
			buf.push(data);
			if (buf.length > 200) buf.shift();
		},
	);

	promise.then((result) => {
		runs.set(result.runId, result);
		runs.set(runId, { ...result, runId });
		activePipelines.delete(name);
	}).catch((err) => {
		runs.set(runId, {
			runId,
			pipelineName: name,
			status: 'failed',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			steps: [],
			resolvedInputs: inputs || {},
		});
		events.push({ stepId: '_pipeline', status: 'failed', detail: (err as Error).message, time: new Date().toISOString() });
		activePipelines.delete(name);
	});

	return json({ runId, status: 'started' });
};

/** GET /api/pipelines/run?id=... — get run status */
export const GET: RequestHandler = async ({ url }) => {
	const runId = url.searchParams.get('id');

	if (!runId) {
		// Return all runs
		const allRuns = Array.from(runs.values()).sort(
			(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
		);
		return json({ runs: allRuns.slice(0, 20) });
	}

	const run = runs.get(runId);
	const events = runEvents.get(runId) || [];
	const outputBuffers = stepOutputBuffers.get(runId);

	// Build step output map (last 50 lines per step for the response)
	const stepOutput: Record<string, string> = {};
	if (outputBuffers) {
		for (const [stepId, lines] of outputBuffers) {
			stepOutput[stepId] = lines.slice(-50).join('');
		}
	}

	if (!run) {
		// Pipeline might still be running — check events
		if (events.length > 0) {
			return json({ runId, status: 'running', events, stepOutput });
		}
		return json({ error: 'Run not found' }, { status: 404 });
	}

	return json({ ...run, events, stepOutput });
};
