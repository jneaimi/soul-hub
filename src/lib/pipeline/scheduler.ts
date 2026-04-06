import cron from 'node-cron';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePipeline } from './parser.js';
import { runPipeline } from './runner.js';
import type { PipelineRun } from './types.js';

/** Per-pipeline automation config (stored in .data/automation.json, NOT in YAML) */
interface AutomationConfig {
	schedule?: string;       // cron expression
	scheduleEnabled?: boolean;
	triggerEnabled?: boolean;
	triggerSecret?: string;  // per-pipeline secret token
}

/** Scheduled job runtime state */
interface ScheduledJob {
	pipelineName: string;
	cronExpr: string;
	task: cron.ScheduledTask;
	enabled: boolean;
	lastRun?: string;
	lastStatus?: string;
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
let automationConfigs: Record<string, AutomationConfig> = {};
let runHistory: RunRecord[] = [];
let historyPath = '';
let automationPath = '';
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
	automationPath = resolve(dataDir, 'automation.json');

	await mkdir(dataDir, { recursive: true });

	// Load persisted run history
	try {
		const raw = await readFile(historyPath, 'utf-8');
		runHistory = JSON.parse(raw);
	} catch {
		runHistory = [];
	}

	// Load automation configs
	try {
		const raw = await readFile(automationPath, 'utf-8');
		automationConfigs = JSON.parse(raw);
	} catch {
		automationConfigs = {};
	}

	// Stop all existing jobs before re-scanning
	for (const [, job] of scheduledJobs) {
		job.task.stop();
	}
	scheduledJobs.clear();

	// Register cron jobs from automation config
	try {
		const entries = await readdir(pipelinesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const yamlPath = resolve(pipelinesDir, entry.name, 'pipeline.yaml');
			try {
				const spec = await parsePipeline(yamlPath);
				const autoConfig = automationConfigs[spec.name];
				if (autoConfig?.schedule && autoConfig.scheduleEnabled !== false) {
					registerSchedule(spec.name, autoConfig.schedule, yamlPath);
				}
			} catch { /* skip invalid */ }
		}
	} catch { /* pipelines dir doesn't exist */ }

	console.log(`[scheduler] Initialized: ${scheduledJobs.size} scheduled, ${Object.keys(automationConfigs).length} configured, ${runHistory.length} history records`);
}

/** Register a cron schedule for a pipeline */
function registerSchedule(name: string, cronExpr: string, yamlPath: string): void {
	if (!cron.validate(cronExpr)) {
		console.error(`[scheduler] Invalid cron expression for "${name}": ${cronExpr}`);
		return;
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

/** Get automation config for a pipeline */
export function getAutomationConfig(name: string): AutomationConfig {
	return automationConfigs[name] || {};
}

/** Update automation config for a pipeline and re-register schedules */
export async function setAutomationConfig(name: string, config: Partial<AutomationConfig>): Promise<void> {
	const existing = automationConfigs[name] || {};
	automationConfigs[name] = { ...existing, ...config };

	// Persist
	await persistAutomation();

	// Re-register schedule if changed
	const autoConfig = automationConfigs[name];
	const existingJob = scheduledJobs.get(name);

	// Stop existing job
	if (existingJob) {
		existingJob.task.stop();
		scheduledJobs.delete(name);
	}

	// Start new job if schedule is configured and enabled
	if (autoConfig.schedule && autoConfig.scheduleEnabled !== false) {
		const yamlPath = resolve(pipelinesDir, name, 'pipeline.yaml');
		registerSchedule(name, autoConfig.schedule, yamlPath);
	}
}

/** Get all automation configs with schedule info */
export function getSchedules(): {
	name: string;
	schedule?: string;
	scheduleEnabled: boolean;
	triggerEnabled: boolean;
	triggerSecret?: string;
	lastRun?: string;
	lastStatus?: string;
}[] {
	const results: ReturnType<typeof getSchedules> = [];
	for (const [name, config] of Object.entries(automationConfigs)) {
		const job = scheduledJobs.get(name);
		results.push({
			name,
			schedule: config.schedule,
			scheduleEnabled: config.scheduleEnabled !== false && !!config.schedule,
			triggerEnabled: config.triggerEnabled !== false,
			triggerSecret: config.triggerSecret,
			lastRun: job?.lastRun,
			lastStatus: job?.lastStatus,
		});
	}
	return results;
}

/** Toggle schedule on/off */
export function toggleSchedule(name: string, enabled: boolean): boolean {
	const config = automationConfigs[name];
	if (!config?.schedule) return false;

	config.scheduleEnabled = enabled;
	persistAutomation();

	const job = scheduledJobs.get(name);
	if (job) {
		if (enabled) job.task.start(); else job.task.stop();
		job.enabled = enabled;
	}
	return true;
}

/** Check if webhook trigger is enabled for a pipeline */
export function isTriggerEnabled(name: string): boolean {
	const config = automationConfigs[name];
	return config?.triggerEnabled !== false;
}

/** Get per-pipeline trigger secret (falls back to global secret) */
export function getTriggerSecret(name: string): string {
	return automationConfigs[name]?.triggerSecret || process.env.SOUL_HUB_WEBHOOK_SECRET || '';
}

/** Execute a pipeline run */
export async function executeScheduledRun(
	name: string,
	yamlPath: string,
	trigger: 'scheduled' | 'webhook' | 'manual',
	inputs?: Record<string, string | number>,
): Promise<{ runId: string; status: string }> {
	if (activePipelines.has(name)) {
		console.log(`[scheduler] Skipping "${name}" — already running`);
		return { runId: '', status: 'skipped' };
	}

	activePipelines.add(name);
	const runId = crypto.randomUUID().slice(0, 8);

	try {
		const result = await runPipeline(yamlPath, inputs || {}, undefined, undefined, runId);

		const record: RunRecord = {
			runId,
			pipelineName: name,
			status: result.status,
			startedAt: result.startedAt,
			finishedAt: result.finishedAt,
			trigger,
			stepSummary: result.steps.map((s) => ({
				id: s.id, status: s.status, durationMs: s.durationMs,
			})),
		};

		const job = scheduledJobs.get(name);
		if (job) {
			job.lastRun = result.startedAt;
			job.lastStatus = result.status;
		}

		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		await persistHistory();

		activePipelines.delete(name);
		return { runId, status: result.status };
	} catch {
		const record: RunRecord = {
			runId, pipelineName: name, status: 'failed',
			startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
			trigger, stepSummary: [],
		};
		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		await persistHistory();
		activePipelines.delete(name);
		return { runId, status: 'failed' };
	}
}

async function persistHistory(): Promise<void> {
	try {
		await writeFile(historyPath, JSON.stringify(runHistory, null, 2));
	} catch (err) {
		console.error(`[scheduler] Failed to persist history: ${err}`);
	}
}

async function persistAutomation(): Promise<void> {
	try {
		await mkdir(resolve(automationPath, '..'), { recursive: true });
		await writeFile(automationPath, JSON.stringify(automationConfigs, null, 2));
	} catch (err) {
		console.error(`[scheduler] Failed to persist automation config: ${err}`);
	}
}

/** Get persisted run history */
export function getRunHistory(limit = 20): RunRecord[] {
	return runHistory.slice(0, limit);
}

/** Shutdown scheduler */
export function shutdownScheduler(): void {
	for (const [, job] of scheduledJobs) {
		job.task.stop();
	}
	scheduledJobs.clear();
}
