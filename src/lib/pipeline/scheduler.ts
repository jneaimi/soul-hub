import cron from 'node-cron';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parsePipeline } from './parser.js';
import { parseChain } from './chain-parser.js';
import { runPipeline } from './runner.js';
import { runChain } from './chain-runner.js';
import { scanFolder, moveFile, ensureWatchDirs, type WatchConfig, type WatchStatus } from './folder-watcher.js';
import type { PipelineRun } from './types.js';

/** Per-pipeline automation config (stored in .data/automation.json, NOT in YAML) */
interface AutomationConfig {
	schedule?: string;       // cron expression
	scheduleEnabled?: boolean;
	triggerEnabled?: boolean;
	triggerSecret?: string;  // per-pipeline secret token
	watch?: WatchConfig;
}

/** Scheduled job runtime state */
interface ScheduledJob {
	pipelineName: string;
	cronExpr: string;
	task: ReturnType<typeof cron.schedule>;
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
	stepSummary: { id: string; status: string; durationMs?: number; error?: string; outputPath?: string; outputType?: string }[];
	type?: 'pipeline' | 'chain';
	nodeSummary?: { id: string; pipeline: string; status: string; durationMs?: number; error?: string; outputPath?: string }[];
}

const scheduledJobs = new Map<string, ScheduledJob>();
let automationConfigs: Record<string, AutomationConfig> = {};

/** Active folder watchers keyed by pipeline/chain name */
const folderWatchers = new Map<string, {
	timer: ReturnType<typeof setInterval>;
	config: WatchConfig;
	folderPath: string;
	yamlPath: string;
	status: WatchStatus;
}>();
let runHistory: RunRecord[] = [];
let savedInputs: Record<string, Record<string, string | number>> = {};
let historyPath = '';
let automationPath = '';
let inputsPath = '';
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
	inputsPath = resolve(dataDir, 'pipeline-inputs.json');

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

	// Load saved pipeline inputs
	try {
		const raw = await readFile(inputsPath, 'utf-8');
		savedInputs = JSON.parse(raw);
	} catch {
		savedInputs = {};
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
			let yamlPath = resolve(pipelinesDir, entry.name, 'pipeline.yaml');
			let specName = '';
			try {
				const spec = await parsePipeline(yamlPath);
				specName = spec.name;
			} catch {
				// Try chain.yaml
				yamlPath = resolve(pipelinesDir, entry.name, 'chain.yaml');
				try {
					const spec = await parseChain(yamlPath);
					specName = spec.name;
				} catch { continue; }
			}
			const autoConfig = automationConfigs[specName];
			if (autoConfig?.schedule && autoConfig.scheduleEnabled !== false) {
				registerSchedule(specName, autoConfig.schedule, yamlPath);
			}
		}
	} catch { /* pipelines dir doesn't exist */ }

	// Register folder watchers from automation config
	for (const [name, autoConfig] of Object.entries(automationConfigs)) {
		if (autoConfig.watch?.enabled && autoConfig.watch.input) {
			try {
				const entries = await readdir(pipelinesDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
					for (const yamlFile of ['pipeline.yaml', 'chain.yaml'] as const) {
						const yamlPath = resolve(pipelinesDir, entry.name, yamlFile);
						try {
							const spec = yamlFile === 'pipeline.yaml'
								? await parsePipeline(yamlPath)
								: await parseChain(yamlPath);
							if (spec.name === name) {
								const folderInput = (spec.inputs || []).find(
									(i) => i.name === autoConfig.watch!.input && i.type === 'folder'
								);
								if (folderInput) {
									const savedInputValue = savedInputs[name]?.[autoConfig.watch!.input];
									const folderPath = String(savedInputValue || folderInput.default || '');
									if (folderPath) {
										registerFolderWatcher(name, autoConfig.watch, folderPath, yamlPath);
									}
								}
							}
						} catch { /* skip */ }
					}
				}
			} catch { /* pipelines dir doesn't exist */ }
		}
	}

	console.log(`[scheduler] Initialized: ${scheduledJobs.size} scheduled, ${folderWatchers.size} watchers, ${Object.keys(automationConfigs).length} configured, ${runHistory.length} history records`);
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

function registerFolderWatcher(
	name: string,
	config: WatchConfig,
	folderPath: string,
	yamlPath: string,
): void {
	const existing = folderWatchers.get(name);
	if (existing) {
		clearInterval(existing.timer);
		folderWatchers.delete(name);
	}

	let resolvedFolder = folderPath;
	if (resolvedFolder.startsWith('~/')) {
		resolvedFolder = resolve(process.env.HOME || '', resolvedFolder.slice(2));
	}

	const pollInterval = Math.max(10, config.poll_interval ?? 60) * 1000;
	const status: WatchStatus = { inProgress: new Set(), history: [] };

	const timer = setInterval(async () => {
		await pollFolder(name, config, resolvedFolder, yamlPath, status);
	}, pollInterval);

	folderWatchers.set(name, { timer, config, folderPath: resolvedFolder, yamlPath, status });
	console.log(`[watcher] Registered: ${name} — watching ${resolvedFolder} every ${config.poll_interval ?? 60}s`);

	ensureWatchDirs(resolvedFolder, config.processed_dir, config.failed_dir).catch(() => {});
}

async function pollFolder(
	name: string,
	config: WatchConfig,
	folderPath: string,
	yamlPath: string,
	status: WatchStatus,
): Promise<void> {
	const maxConcurrent = Math.min(config.max_concurrent ?? 1, 5);

	const available = maxConcurrent - status.inProgress.size;
	if (available <= 0) return;

	const files = await scanFolder(folderPath, config.pattern, config.stable_seconds ?? 5);

	const newFiles = files.filter(f => !status.inProgress.has(f));
	if (newFiles.length === 0) return;

	const batch = newFiles.slice(0, available);

	for (const filename of batch) {
		status.inProgress.add(filename);
		const filePath = join(folderPath, filename);

		console.log(`[watcher] Processing: ${filename} for ${name}`);

		const inputs: Record<string, string | number> = { [config.input]: filePath };

		const saved = savedInputs[name] || {};
		for (const [key, val] of Object.entries(saved)) {
			if (key !== config.input) inputs[key] = val;
		}

		try {
			const result = await executeScheduledRun(name, yamlPath, 'webhook', inputs);

			const processedDir = join(folderPath, config.processed_dir ?? 'processed');
			const failedDir = join(folderPath, config.failed_dir ?? 'failed');

			if (result.status === 'done') {
				try {
					await moveFile(filePath, processedDir, filename);
					addWatchHistory(status, filename, 'processed');
					console.log(`[watcher] Done: ${filename} → processed/`);
				} catch (moveErr) {
					addWatchHistory(status, filename, 'move-failed', String(moveErr));
					console.error(`[watcher] Move failed for ${filename}: ${moveErr}`);
				}
			} else {
				try {
					await moveFile(filePath, failedDir, filename);
					addWatchHistory(status, filename, 'failed', `Pipeline status: ${result.status}`);
					console.log(`[watcher] Failed: ${filename} → failed/`);
				} catch (moveErr) {
					addWatchHistory(status, filename, 'move-failed', String(moveErr));
				}
			}
		} catch (err) {
			const failedDir = join(folderPath, config.failed_dir ?? 'failed');
			try {
				await moveFile(filePath, failedDir, filename);
			} catch { /* already logged */ }
			addWatchHistory(status, filename, 'failed', String(err));
			console.error(`[watcher] Error processing ${filename}: ${err}`);
		} finally {
			status.inProgress.delete(filename);
		}
	}
}

function addWatchHistory(status: WatchStatus, filename: string, result: 'processed' | 'failed' | 'move-failed', error?: string): void {
	status.history.unshift({
		filename,
		status: result,
		timestamp: new Date().toISOString(),
		...(error ? { error } : {}),
	});
	if (status.history.length > 10) status.history = status.history.slice(0, 10);
}

/** Get watch status for a pipeline/chain */
export function getWatchStatus(name: string): { config: WatchConfig; folderPath: string; inProgress: string[]; history: WatchStatus['history'] } | null {
	const watcher = folderWatchers.get(name);
	if (!watcher) return null;
	return {
		config: watcher.config,
		folderPath: watcher.folderPath,
		inProgress: [...watcher.status.inProgress],
		history: watcher.status.history,
	};
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

	// Re-register folder watcher if changed
	if (config.watch !== undefined) {
		const existingWatcher = folderWatchers.get(name);
		if (existingWatcher) {
			clearInterval(existingWatcher.timer);
			folderWatchers.delete(name);
		}

		if (autoConfig.watch?.enabled && autoConfig.watch.input) {
			const savedFolder = savedInputs[name]?.[autoConfig.watch.input];
			if (savedFolder) {
				const yamlPath = resolve(pipelinesDir, name, 'pipeline.yaml');
				const chainPath = resolve(pipelinesDir, name, 'chain.yaml');
				let actualPath = yamlPath;
				try { await access(yamlPath); } catch { actualPath = chainPath; }
				registerFolderWatcher(name, autoConfig.watch, String(savedFolder), actualPath);
			}
		}
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
	// Atomic check-and-set before any await to prevent race between cron and watcher triggers
	if (activePipelines.has(name)) {
		console.log(`[scheduler] Skipping "${name}" — already running`);
		return { runId: '', status: 'skipped' };
	}
	activePipelines.add(name);

	// Guard: verify pipeline YAML still exists (prevents ghost runs for archived pipelines)
	try {
		await access(yamlPath);
	} catch {
		activePipelines.delete(name);
		console.warn(`[scheduler] Skipping "${name}" — pipeline YAML not found: ${yamlPath}`);
		const job = scheduledJobs.get(name);
		if (job) { job.task.stop(); scheduledJobs.delete(name); }
		return { runId: '', status: 'skipped' };
	}

	// Guard: verify schedule is still enabled (protects against ghost cron jobs)
	if (trigger === 'scheduled') {
		const autoConfig = automationConfigs[name];
		if (!autoConfig?.schedule || autoConfig.scheduleEnabled === false) {
			activePipelines.delete(name);
			console.log(`[scheduler] Blocking ghost trigger for "${name}" — no active schedule`);
			const job = scheduledJobs.get(name);
			if (job) { job.task.stop(); scheduledJobs.delete(name); }
			return { runId: '', status: 'blocked' };
		}
	}

	const runId = crypto.randomUUID().slice(0, 8);

	try {
		const isChain = yamlPath.endsWith('chain.yaml');
		let record: RunRecord;

		if (isChain) {
			const result = await runChain(yamlPath, inputs || {}, undefined, undefined, undefined, runId);
			record = {
				runId,
				pipelineName: name,
				status: result.status,
				startedAt: result.startedAt,
				finishedAt: result.finishedAt,
				trigger,
				type: 'chain',
				stepSummary: [],
				nodeSummary: result.nodes.map((n) => ({
					id: n.id, pipeline: n.pipelineName, status: n.status, durationMs: n.durationMs,
					...(n.error ? { error: n.error } : {}),
					...(n.outputPath ? { outputPath: n.outputPath } : {}),
				})),
			};
		} else {
			const result = await runPipeline(yamlPath, inputs || {}, undefined, undefined, runId);
			record = {
				runId,
				pipelineName: name,
				status: result.status,
				startedAt: result.startedAt,
				finishedAt: result.finishedAt,
				trigger,
				type: 'pipeline',
				stepSummary: result.steps.map((s) => ({
					id: s.id, status: s.status, durationMs: s.durationMs,
					...(s.error ? { error: s.error } : {}),
					...(s.outputPath ? { outputPath: s.outputPath } : {}),
					...(s.outputType ? { outputType: s.outputType } : {}),
				})),
			};
		}

		const job = scheduledJobs.get(name);
		if (job) {
			job.lastRun = record.startedAt;
			job.lastStatus = record.status;
		}

		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		debouncedPersistHistory();

		activePipelines.delete(name);
		return { runId, status: record.status };
	} catch {
		const record: RunRecord = {
			runId, pipelineName: name, status: 'failed',
			startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
			trigger, stepSummary: [],
		};
		runHistory.unshift(record);
		if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
		debouncedPersistHistory();
		activePipelines.delete(name);
		return { runId, status: 'failed' };
	}
}

let historyWriteTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistHistory(): void {
	if (historyWriteTimer) clearTimeout(historyWriteTimer);
	historyWriteTimer = setTimeout(() => {
		persistHistory();
		historyWriteTimer = null;
	}, 2000);
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

/** Record a manual run (from UI) into persisted history */
export function recordManualRun(record: { runId: string; pipelineName: string; status: string; startedAt: string; finishedAt?: string; steps?: { id: string; status: string; durationMs?: number; error?: string }[] }): void {
	const entry: RunRecord = {
		runId: record.runId,
		pipelineName: record.pipelineName,
		status: record.status,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		trigger: 'manual',
		stepSummary: (record.steps || []).map(s => ({ id: s.id, status: s.status, durationMs: s.durationMs, error: s.error })),
	};
	runHistory.unshift(entry);
	if (runHistory.length > 100) runHistory = runHistory.slice(0, 100);
	debouncedPersistHistory();
}

/** Get saved inputs for a pipeline */
export function getSavedInputs(name: string): Record<string, string | number> {
	return savedInputs[name] || {};
}

/** Remove all automation state for a pipeline (schedule, watcher, saved inputs) */
export async function cleanupPipelineState(name: string): Promise<void> {
	// Stop scheduled job
	const job = scheduledJobs.get(name);
	if (job) { job.task.stop(); scheduledJobs.delete(name); }

	// Stop folder watcher
	const watcher = folderWatchers.get(name);
	if (watcher) { clearInterval(watcher.timer); folderWatchers.delete(name); }

	// Remove automation config
	if (automationConfigs[name]) {
		delete automationConfigs[name];
		await persistAutomation();
	}

	// Remove saved inputs
	if (savedInputs[name]) {
		delete savedInputs[name];
		try { await writeFile(inputsPath, JSON.stringify(savedInputs, null, 2)); } catch { /* best effort */ }
	}
}

/** Save inputs for a pipeline (persists to disk) */
export async function saveInputs(name: string, inputs: Record<string, string | number>): Promise<void> {
	savedInputs[name] = inputs;
	try {
		await writeFile(inputsPath, JSON.stringify(savedInputs, null, 2));
	} catch (err) {
		console.error(`[scheduler] Failed to persist inputs: ${err}`);
	}
}


