import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parsePipeline } from './parser.js';
import { runPipeline } from './runner.js';
import type { PipelineRun, PipelineSpec } from './types.js';

/** Scheduled job state */
interface ScheduledJob {
	pipelineName: string;
	cronExpr: string;
	task: cron.ScheduledTask;
	enabled: boolean;
	lastRun?: string;
	lastStatus?: string;
	nextRun?: string;
}

/** Run history entry persisted to disk */
interface RunRecord {
	runId: string;
	pipelineName: string;
	status: string;
	startedAt: string;
	finishedAt?: string;
	trigger: 'manual' | 'scheduled' | 'webhook';
	stepSummary: { id: string; status: string; durationMs?: number }[];
}

const scheduledJobs = new Map<string, ScheduledJob>();
let runHistory: RunRecord[] = [];
let historyPath = '';
let pipelinesDir = '';

// Concurrency lock (shared with the API)
const activePipelines = new Set<string>();

export function getActivePipelines(): Set<string> {
	return activePipelines;
}

/** Initialize the scheduler — call once at server startup */
export async function initScheduler(pipDir: string, dataDir: string): Promise<void> {
	pipelinesDir = pipDir;
	historyPath = resolve(dataDir, 'run-history.json');

	// Load persisted run history
	try {
		const raw = await readFile(historyPath, 'utf-8');
		runHistory = JSON.parse(raw);
	} catch {
		runHistory = [];
	}

	// Scan pipelines for schedule: fields and register cron jobs
	const { readdir } = await import('node:fs/promises');
	try {
		const entries = await readdir(pipelinesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const yamlPath = resolve(pipelinesDir, entry.name, 'pipeline.yaml');
			try {
				const spec = await parsePipeline(yamlPath);
				if (spec.schedule) {
					registerSchedule(spec.name, spec.schedule, yamlPath);
				}
			} catch { /* skip invalid */ }
		}
	} catch { /* pipelines dir doesn't exist */ }

	console.log(`[scheduler] Initialized: ${scheduledJobs.size} scheduled pipelines, ${runHistory.length} history records`);
}

/** Register a cron schedule for a pipeline */
function registerSchedule(name: string, cronExpr: string, yamlPath: string): void {
	// Validate cron expression
	if (!cron.validate(cronExpr)) {
		console.error(`[scheduler] Invalid cron expression for "${name}": ${cronExpr}`);
		return;
	}

	// Remove existing schedule if any
	const existing = scheduledJobs.get(name);
	if (existing) {
		existing.task.stop();
	}

	const task = cron.schedule(cronExpr, async () => {
		console.log(`[scheduler] Triggered: ${name}`);
		await executeScheduledRun(name, yamlPath, 'scheduled');
	});

	scheduledJobs.set(name, {
		pipelineName: name,
		cronExpr,
		task,
		enabled: true,
	});

	console.log(`[scheduler] Registered: ${name} — ${cronExpr}`);
}

/** Execute a pipeline run (used by scheduler and webhook trigger) */
export async function executeScheduledRun(
	name: string,
	yamlPath: string,
	trigger: 'scheduled' | 'webhook' | 'manual',
	inputs?: Record<string, string | number>,
): Promise<{ runId: string; status: string }> {
	// Concurrency check
	if (activePipelines.has(name)) {
		console.log(`[scheduler] Skipping "${name}" — already running`);
		return { runId: '', status: 'skipped' };
	}

	activePipelines.add(name);
	const runId = crypto.randomUUID().slice(0, 8);

	try {
		const result = await runPipeline(
			yamlPath,
			inputs || {},
			undefined, // no step event callback for scheduled runs
			undefined, // no step output callback
			runId,
		);

		const record: RunRecord = {
			runId,
			pipelineName: name,
			status: result.status,
			startedAt: result.startedAt,
			finishedAt: result.finishedAt,
			trigger,
			stepSummary: result.steps.map((s) => ({
				id: s.id,
				status: s.status,
				durationMs: s.durationMs,
			})),
		};

		// Update job state
		const job = scheduledJobs.get(name);
		if (job) {
			job.lastRun = result.startedAt;
			job.lastStatus = result.status;
		}

		// Persist to history
		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		await persistHistory();

		activePipelines.delete(name);
		return { runId, status: result.status };
	} catch (err) {
		const record: RunRecord = {
			runId,
			pipelineName: name,
			status: 'failed',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			trigger,
			stepSummary: [],
		};
		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		await persistHistory();

		activePipelines.delete(name);
		return { runId, status: 'failed' };
	}
}

/** Persist run history to disk */
async function persistHistory(): Promise<void> {
	try {
		await mkdir(dirname(historyPath), { recursive: true });
		await writeFile(historyPath, JSON.stringify(runHistory, null, 2));
	} catch (err) {
		console.error(`[scheduler] Failed to persist history: ${err}`);
	}
}

/** Get all scheduled jobs */
export function getSchedules(): {
	name: string;
	cronExpr: string;
	enabled: boolean;
	lastRun?: string;
	lastStatus?: string;
}[] {
	return Array.from(scheduledJobs.values()).map((j) => ({
		name: j.pipelineName,
		cronExpr: j.cronExpr,
		enabled: j.enabled,
		lastRun: j.lastRun,
		lastStatus: j.lastStatus,
	}));
}

/** Enable/disable a scheduled job */
export function toggleSchedule(name: string, enabled: boolean): boolean {
	const job = scheduledJobs.get(name);
	if (!job) return false;
	job.enabled = enabled;
	if (enabled) {
		job.task.start();
	} else {
		job.task.stop();
	}
	return true;
}

/** Get persisted run history */
export function getRunHistory(limit = 20): RunRecord[] {
	return runHistory.slice(0, limit);
}

/** Shutdown scheduler — stop all jobs */
export function shutdownScheduler(): void {
	for (const [, job] of scheduledJobs) {
		job.task.stop();
	}
	scheduledJobs.clear();
	console.log('[scheduler] Shutdown complete');
}
