<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import FilePreview from '$lib/components/FilePreview.svelte';
	import OutputViewer from '$lib/components/OutputViewer.svelte';
	import LogTerminal from '$lib/components/LogTerminal.svelte';
	import type { OutputEntry } from '$lib/components/OutputViewer.svelte';
	import StepConfigCard from '$lib/components/StepConfigCard.svelte';
	import SharedConfigEditor from '$lib/components/SharedConfigEditor.svelte';
	import ChainNodeFlow from '$lib/components/ChainNodeFlow.svelte';
	import type { ConfigFieldType } from '$lib/pipeline/block';

	interface Pipeline {
		name: string;
		path: string;
		description: string;
		type?: 'pipeline' | 'chain';
	}

	interface PipelineDetail {
		name: string;
		description: string;
		version?: string;
		author?: string;
		inputs?: { name: string; type: string; description: string; default?: string | number; options?: string[]; required?: boolean }[];
		config_files?: { name: string; description: string; path: string; columns?: { name: string; type: 'text' | 'select' | 'number'; label: string; placeholder?: string; options?: string[]; required?: boolean }[] }[];
		steps: { id: string; type: string; block?: string; config?: Record<string, unknown>; agent?: string; run?: string; depends_on?: string[]; when?: string; skip_if?: string }[];
	}

	interface BlockManifest {
		name: string;
		type: string;
		runtime?: string;
		description: string;
		version?: string;
		outputs?: { name: string; type: string; format?: string; description?: string }[];
		config?: { name: string; type: ConfigFieldType; label?: string; description?: string; default?: unknown; min?: number; max?: number; options?: string[]; required?: boolean }[];
		env?: { name: string; description?: string; required?: boolean }[];
	}

	interface EnvStatus {
		name: string;
		description: string;
		required: boolean;
		set: boolean;
	}

	interface StepEvent {
		stepId: string;
		status: string;
		detail?: string;
		time: string;
	}

	interface RunResult {
		runId: string;
		pipelineName: string;
		status: string;
		startedAt: string;
		finishedAt?: string;
		steps: { id: string; status: string; durationMs?: number; outputPath?: string; error?: string; attempt: number }[];
		events: StepEvent[];
		stepOutput: Record<string, string>;
		_error?: string;
	}

	// Page state
	let pipelines = $state<Pipeline[]>([]);
	let loading = $state(true);
	let pipelineFilter = $state('');

	const filteredPipelines = $derived(
		pipelines.filter((p) => p.name.toLowerCase().includes(pipelineFilter.toLowerCase()))
	);

	// Selected pipeline
	let selected = $state<PipelineDetail | null>(null);
	let selectedName = $state('');
	let selectedPath = $state('');
	let inputValues = $state<Record<string, string | number>>({});
	let envStatus = $state<EnvStatus[]>([]);

	// Selected pipeline schedule state
	let selectedSchedule = $state<Schedule | null>(null);
	let webhookUrl = $state('');
	let cfClientId = $state('');
	let cfClientSecret = $state('');
	let editingSchedule = $state(false);
	let scheduleInput = $state('');
	let scheduleSaving = $state(false);
	let editingSecret = $state(false);
	let secretInput = $state('');

	// Run state
	let activeRun = $state<RunResult | null>(null);
	let running = $state(false);
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// File path validation for type: file/path inputs
	let filePathStatus = $state<Record<string, 'valid' | 'invalid' | 'checking'>>({});
	let filePathTimers = $state<Record<string, ReturnType<typeof setTimeout>>>({});

	// Folder file count for type: folder inputs
	let folderFileCount = $state<Record<string, number>>({});
	let folderPathTimers = $state<Record<string, ReturnType<typeof setTimeout>>>({});

	function validateFolderPath(inputName: string, path: string) {
		if (folderPathTimers[inputName]) clearTimeout(folderPathTimers[inputName]);
		if (!path || path.length < 2) {
			const next = { ...filePathStatus };
			delete next[inputName];
			filePathStatus = next;
			const nextCount = { ...folderFileCount };
			delete nextCount[inputName];
			folderFileCount = nextCount;
			return;
		}
		filePathStatus = { ...filePathStatus, [inputName]: 'checking' };
		folderPathTimers[inputName] = setTimeout(async () => {
			try {
				const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
				if (res.ok) {
					const data = await res.json();
					filePathStatus = { ...filePathStatus, [inputName]: 'valid' };
					const fileEntries = (data.entries || []).filter((e: { type: string; name: string }) => e.type === 'file' && !e.name.startsWith('.'));
					folderFileCount = { ...folderFileCount, [inputName]: fileEntries.length };
				} else {
					filePathStatus = { ...filePathStatus, [inputName]: 'invalid' };
				}
			} catch {
				filePathStatus = { ...filePathStatus, [inputName]: 'invalid' };
			}
		}, 500);
	}

	// Watch state
	let watchEnabled = $state(false);
	let watchInput = $state('');
	let watchPattern = $state('*.csv');
	let watchPollInterval = $state(60);
	let watchStatus = $state<{ inProgress: string[]; history: { filename: string; status: string; timestamp: string; error?: string }[] } | null>(null);

	// Derived: folder inputs available for watch
	let folderInputs = $derived.by(() => {
		const inputs = selectedChain?.inputs || selected?.inputs || [];
		return inputs.filter(i => i.type === 'folder');
	});

	function validateFilePath(inputName: string, path: string) {
		// Clear previous timer (debounce)
		if (filePathTimers[inputName]) clearTimeout(filePathTimers[inputName]);
		if (!path || path.length < 2) {
			const next = { ...filePathStatus };
			delete next[inputName];
			filePathStatus = next;
			return;
		}
		filePathStatus = { ...filePathStatus, [inputName]: 'checking' };
		filePathTimers[inputName] = setTimeout(async () => {
			try {
				const res = await fetch(`/api/files?path=${encodeURIComponent(path)}&action=read&file=.`);
				// Try stat-like check: if it's a file, try reading it; if dir, list it
				const dirRes = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
				filePathStatus = { ...filePathStatus, [inputName]: (res.ok || dirRes.ok) ? 'valid' : 'invalid' };
			} catch {
				filePathStatus = { ...filePathStatus, [inputName]: 'invalid' };
			}
		}, 500);
	}

	// Step card expansion
	let expandedSteps = $state<Set<string>>(new Set());

	// Per-step config overrides (edited via StepConfigCard widgets)
	let stepConfigEdits = $state<Record<string, Record<string, unknown>>>({});

	// Gate state (approval/prompt steps waiting for user action)
	interface GateInfo {
		type: 'approval' | 'prompt';
		message?: string;
		question?: string;
		show?: string;
		options?: string[];
		options_from?: string;
	}
	let activeGates = $state<Map<string, GateInfo>>(new Map());
	let promptAnswers = $state<Record<string, string>>({});
	let showFileContent = $state<Record<string, string>>({});
	let gateSubmitting = $state<Set<string>>(new Set());

	// Run history
	let history = $state<RunResult[]>([]);

	// Collapsible settings
	let showSettings = $state(false);

	// Output browser
	let previewFile = $state<{ path: string; name: string } | null>(null);

	// Block info
	let installedBlocks = $state<BlockManifest[]>([]);
	let fixRequests = $state<{ name: string; content: string }[]>([]);

	let activeRunId = $state<string | null>(null);

	// Chain state
	interface ChainNode {
		id: string;
		pipeline: string;
		inputs?: Record<string, string>;
		depends_on?: string[];
		when?: string;
	}
	interface ChainSpec {
		name: string;
		description: string;
		type: 'chain';
		inputs?: { name: string; type: string; description: string; default?: string | number; options?: string[]; required?: boolean }[];
		nodes: ChainNode[];
	}
	interface NodeDetail {
		id: string;
		pipeline: string;
		description: string;
		stepCount: number;
		inputs?: { name: string; type: string; description: string }[];
	}
	interface ChainNodeRun {
		id: string;
		pipelineName: string;
		status: string;
		durationMs?: number;
		error?: string;
		outputPath?: string;
		pipelineRun?: { steps: { id: string; status: string }[] };
	}
	interface ChainRun {
		runId: string;
		chainName: string;
		status: string;
		startedAt: string;
		finishedAt?: string;
		nodes: ChainNodeRun[];
		type: 'chain';
	}
	let selectedChain = $state<ChainSpec | null>(null);
	let chainNodeDetails = $state<NodeDetail[]>([]);
	let activeChainRun = $state<ChainRun | null>(null);


	// Mobile detection (coarse pointer = touch device)
	let isMobile = $state(false);

	// Schedules
	interface Schedule {
		name: string;
		schedule?: string;
		scheduleEnabled: boolean;
		triggerEnabled: boolean;
		triggerSecret?: string;
		lastRun?: string;
		lastStatus?: string;
	}
	interface HistoryRecord {
		runId: string;
		pipelineName: string;
		status: string;
		startedAt: string;
		finishedAt?: string;
		trigger: string;
		stepSummary: { id: string; status: string; durationMs?: number; error?: string; outputPath?: string; outputType?: string }[];
		type?: 'pipeline' | 'chain';
		nodeSummary?: { id: string; pipeline: string; status: string; durationMs?: number; error?: string; outputPath?: string }[];
	}
	let schedules = $state<Schedule[]>([]);
	let persistedHistory = $state<HistoryRecord[]>([]);

	// Collapsed history: group consecutive failures for the same pipeline
	interface CollapsedRecord {
		records: HistoryRecord[];
		count: number;
	}
	let collapsedHistory = $derived.by((): CollapsedRecord[] => {
		const result: CollapsedRecord[] = [];
		for (const record of persistedHistory) {
			const prev = result[result.length - 1];
			if (
				prev &&
				prev.records[0].pipelineName === record.pipelineName &&
				prev.records[0].status === 'failed' &&
				record.status === 'failed'
			) {
				prev.records.push(record);
				prev.count++;
			} else {
				result.push({ records: [record], count: 1 });
			}
		}
		return result;
	});

	// Validation: missing env vars and required inputs
	let missingEnvVars = $derived(envStatus.filter(e => e.required && !e.set));
	let missingInputs = $derived.by(() => {
		if (!selected?.inputs) return [];
		return selected.inputs.filter(input => {
			if (input.required === false) return false;
			const val = inputValues[input.name];
			return val === undefined || val === '' || val === null;
		});
	});
	let canRun = $derived(missingEnvVars.length === 0 && missingInputs.length === 0);

	// Progress tracking for sticky run bar
	let runProgress = $derived.by(() => {
		if (!selected || !running || !activeRun) return null;
		const total = selected.steps.length;
		let completed = 0;
		let currentStep: string | null = null;
		for (const step of selected.steps) {
			const status = getStepStatus(step.id);
			if (status === 'done' || status === 'skipped') completed++;
			if (status === 'running' && !currentStep) currentStep = step.id;
		}
		return { total, completed, currentStep };
	});

	// Build structured output entries from completed run steps + block manifests
	let runOutputs = $derived.by((): OutputEntry[] => {
		if (!activeRun || activeRun.status !== 'done') return [];
		const entries: OutputEntry[] = [];
		for (const step of activeRun.steps) {
			if (step.status !== 'done' || !step.outputPath) continue;
			// Find block manifest for this step to get declared outputs
			const stepSpec = selected?.steps?.find(s => s.id === step.id);
			const blockName = stepSpec?.block;
			const manifest = blockName ? installedBlocks.find(b => b.name === blockName) : null;
			if (manifest?.outputs && manifest.outputs.length > 0) {
				// Use the step's actual output path with block's declared format
				const out = manifest.outputs[0];
				const fileName = step.outputPath.split('/').pop() || step.id;
				entries.push({
					name: fileName,
					path: step.outputPath,
					type: out.type || 'file',
					format: out.format,
				});
			} else {
				// Fallback: use actual filename from path
				const fallbackName = step.outputPath.split('/').pop() || step.id;
				entries.push({
					name: fallbackName,
					path: step.outputPath,
					type: 'file',
					format: 'text',
				});
			}
		}
		return entries;
	});

	const statusIcon: Record<string, string> = {
		pending: '○', running: '◉', done: '✓', failed: '✗', skipped: '–', waiting: '◎',
	};
	const statusColor: Record<string, string> = {
		waiting: 'text-hub-warning',
		pending: 'text-hub-dim',
		running: 'text-hub-info',
		done: 'text-hub-cta',
		failed: 'text-hub-danger',
		skipped: 'text-hub-dim',
	};

	onMount(async () => {
		isMobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;

		try {
			const res = await fetch('/api/pipelines');
			if (res.ok) {
				const data = await res.json();
				pipelines = data.pipelines || [];
			}
		} catch { /* silent */ }
		loading = false;

		// Auto-select pipeline from URL ?name= param (e.g. returning from builder)
		const urlName = new URL(window.location.href).searchParams.get('name');
		if (urlName && pipelines.some(p => p.name === urlName)) {
			await selectPipeline(urlName);
		}

		// Load run history (in-memory)
		try {
			const res = await fetch('/api/pipelines/run');
			if (res.ok) {
				const data = await res.json();
				history = (data.runs || []).filter((r: RunResult) => r.status === 'done' || r.status === 'failed');
			}
		} catch { /* silent */ }

		// Load schedules + persisted history
		try {
			const res = await fetch('/api/pipelines/schedules');
			if (res.ok) {
				const data = await res.json();
				schedules = data.schedules || [];
				persistedHistory = data.history || [];
			}
		} catch { /* silent */ }

		// Load CF Access credentials for remote curl
		try {
			const res = await fetch('/api/secrets/cf-access');
			if (res.ok) {
				const data = await res.json();
				cfClientId = data.clientId || '';
				cfClientSecret = data.clientSecret || '';
			}
		} catch { /* silent */ }
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});

	async function selectPipeline(name: string) {
		selectedName = name;
		// Update URL so returning from builder restores the selection
		const url = new URL(window.location.href);
		url.searchParams.set('name', name);
		window.history.replaceState(null, '', url.toString());
		try {
			const res = await fetch(`/api/pipelines?name=${encodeURIComponent(name)}`);
			if (res.ok) {
				const data = await res.json();
				if (data.type === 'chain') {
					selectedChain = data.chain;
					chainNodeDetails = data.nodeDetails || [];
					selected = null;
					selectedPath = data.path || '';
					inputValues = {};
					for (const input of data.chain.inputs || []) {
						const saved = data.savedInputs || {};
						if (saved[input.name] !== undefined) {
							inputValues[input.name] = saved[input.name];
						} else if (input.default !== undefined) {
							inputValues[input.name] = input.default;
						}
					}
					envStatus = data.envStatus || [];
					selectedSchedule = schedules.find((s) => s.name === name) || null;
					if (!selectedSchedule) {
						selectedSchedule = { name, scheduleEnabled: false, triggerEnabled: true };
					}
					webhookUrl = `${window.location.origin}/api/pipelines/trigger`;
					// Load watch config
					try {
						const cfgRes = await fetch(`/api/pipelines/config?name=${encodeURIComponent(name)}`);
						if (cfgRes.ok) {
							const cfg = await cfgRes.json();
							if (cfg.watch) {
								watchEnabled = cfg.watch.enabled !== false;
								watchInput = cfg.watch.input || '';
								watchPattern = cfg.watch.pattern || '*.csv';
								watchPollInterval = cfg.watch.poll_interval || 60;
							}
							watchStatus = cfg.watchStatus || null;
						}
					} catch { /* silent */ }
					// Restore last run if available (e.g. returning from builder after troubleshoot)
					try {
						const lastRunRes = await fetch(`/api/pipelines/run?last=${encodeURIComponent(name)}`);
						if (lastRunRes.ok) {
							const lastRun = await lastRunRes.json();
							if (lastRun.type === 'chain' && lastRun.status) {
								activeChainRun = lastRun;
							}
						}
					} catch { /* no last run */ }
					return;
				}
				selected = { ...data.pipeline, config_files: data.config_files || [] };
				selectedChain = null;
				activeChainRun = null;
				selectedPath = data.path || '';
				// Load inputs: saved values > defaults
				inputValues = {};
				const saved = data.savedInputs || {};
				for (const input of data.pipeline.inputs || []) {
					if (saved[input.name] !== undefined) {
						inputValues[input.name] = saved[input.name];
					} else if (input.default !== undefined) {
						inputValues[input.name] = input.default;
					}
				}
				// Load env var status for validation
				envStatus = data.envStatus || [];
				// Load block info
				installedBlocks = data.installedBlocks || [];
				fixRequests = data.fixRequests || [];
				// Load automation config for this pipeline
				selectedSchedule = schedules.find((s) => s.name === name) || null;
				// Load fresh config if not in schedules yet
				if (!selectedSchedule) {
					try {
						const cfgRes = await fetch(`/api/pipelines/config?name=${encodeURIComponent(name)}`);
						if (cfgRes.ok) {
							const cfg = await cfgRes.json();
							selectedSchedule = {
								name,
								schedule: cfg.schedule,
								scheduleEnabled: cfg.scheduleEnabled !== false && !!cfg.schedule,
								triggerEnabled: cfg.triggerEnabled !== false,
								triggerSecret: cfg.triggerSecret,
							};
						}
					} catch { /* silent */ }
				}
				if (!selectedSchedule) {
					selectedSchedule = { name, scheduleEnabled: false, triggerEnabled: true };
				}
				webhookUrl = `${window.location.origin}/api/pipelines/trigger`;
				// Load watch config
				try {
					const cfgRes2 = await fetch(`/api/pipelines/config?name=${encodeURIComponent(name)}`);
					if (cfgRes2.ok) {
						const cfg2 = await cfgRes2.json();
						if (cfg2.watch) {
							watchEnabled = cfg2.watch.enabled !== false;
							watchInput = cfg2.watch.input || '';
							watchPattern = cfg2.watch.pattern || '*.csv';
							watchPollInterval = cfg2.watch.poll_interval || 60;
						}
						watchStatus = cfg2.watchStatus || null;
					}
				} catch { /* silent */ }
				// Restore last run if available (e.g. returning from builder after troubleshoot)
				try {
					const lastRunRes = await fetch(`/api/pipelines/run?last=${encodeURIComponent(name)}`);
					if (lastRunRes.ok) {
						const lastRun = await lastRunRes.json();
						if (lastRun.status && !lastRun.type) {
							activeRun = lastRun;
							// Auto-expand completed/failed steps
							for (const step of lastRun.steps || []) {
								if (step.status === 'done' || step.status === 'failed') {
									expandedSteps.add(step.id);
								}
							}
							expandedSteps = new Set(expandedSteps);
						}
					}
				} catch { /* no last run */ }
			}
		} catch { /* silent */ }
	}


	function back() {
		selected = null;
		selectedChain = null;
		chainNodeDetails = [];
		activeChainRun = null;
		selectedName = '';
		showSettings = false;
		activeRun = null;
		activeRunId = null;
		running = false;
		expandedSteps = new Set();
		stepConfigEdits = {};
		envStatus = [];
		selectedPath = '';
		previewFile = null;
		activeGates = new Map();
		promptAnswers = {};
		showFileContent = {};
		gateSubmitting = new Set();
		installedBlocks = [];
		fixRequests = [];
		selectedSchedule = null;
		webhookUrl = '';
		editingSchedule = false;
		scheduleInput = '';
		scheduleSaving = false;
		editingSecret = false;
		secretInput = '';
		filePathStatus = {};
		folderFileCount = {};
		watchEnabled = false;
		watchInput = '';
		watchPattern = '*.csv';
		watchPollInterval = 60;
		watchStatus = null;
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
		// Clear URL ?name= param so refresh doesn't re-select
		const url = new URL(window.location.href);
		if (url.searchParams.has('name')) {
			url.searchParams.delete('name');
			window.history.replaceState(null, '', url.toString());
		}
	}

	async function loadShowFile(stepId: string, filePath: string) {
		try {
			// Split into directory + filename for the files API
			const lastSlash = filePath.lastIndexOf('/');
			const dir = filePath.substring(0, lastSlash);
			const file = filePath.substring(lastSlash + 1);
			const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}&action=read&file=${encodeURIComponent(file)}`);
			if (res.ok) {
				const data = await res.json();
				showFileContent[stepId] = data.content || '';
			}
		} catch { /* silent */ }
	}

	async function handleApprove(stepId: string) {
		if (!activeRunId) return;
		gateSubmitting.add(stepId);
		gateSubmitting = new Set(gateSubmitting);
		try {
			await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve', runId: activeRunId, stepId }),
			});
			activeGates.delete(stepId);
			activeGates = new Map(activeGates);
		} catch { /* silent */ }
		gateSubmitting.delete(stepId);
		gateSubmitting = new Set(gateSubmitting);
	}

	async function handleReject(stepId: string) {
		if (!activeRunId) return;
		gateSubmitting.add(stepId);
		gateSubmitting = new Set(gateSubmitting);
		try {
			await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject', runId: activeRunId, stepId, reason: 'Rejected by user' }),
			});
			activeGates.delete(stepId);
			activeGates = new Map(activeGates);
		} catch { /* silent */ }
		gateSubmitting.delete(stepId);
		gateSubmitting = new Set(gateSubmitting);
	}

	async function handleAnswer(stepId: string) {
		if (!activeRunId) return;
		const value = promptAnswers[stepId] || '';
		if (!value) return;
		gateSubmitting.add(stepId);
		gateSubmitting = new Set(gateSubmitting);
		try {
			await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'answer', runId: activeRunId, stepId, value }),
			});
			activeGates.delete(stepId);
			activeGates = new Map(activeGates);
		} catch { /* silent */ }
		gateSubmitting.delete(stepId);
		gateSubmitting = new Set(gateSubmitting);
	}

	async function saveSchedule(name: string, cronExpr: string | null) {
		scheduleSaving = true;
		try {
			const res = await fetch('/api/pipelines/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, schedule: cronExpr, scheduleEnabled: !!cronExpr }),
			});
			if (res.ok) {
				editingSchedule = false;
				// Refresh schedules
				const schedRes = await fetch('/api/pipelines/schedules');
				if (schedRes.ok) {
					const data = await schedRes.json();
					schedules = data.schedules || [];
				}
				// Update local state
				if (selectedSchedule) {
					selectedSchedule = { ...selectedSchedule, schedule: cronExpr || undefined, scheduleEnabled: !!cronExpr };
				}
			}
		} catch { /* silent */ }
		scheduleSaving = false;
	}

	async function saveTriggerConfig(name: string, updates: { triggerEnabled?: boolean; triggerSecret?: string | null }) {
		try {
			await fetch('/api/pipelines/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, ...updates }),
			});
			if (selectedSchedule) {
				selectedSchedule = {
					...selectedSchedule,
					...(updates.triggerEnabled !== undefined ? { triggerEnabled: updates.triggerEnabled } : {}),
					...(updates.triggerSecret !== undefined ? { triggerSecret: updates.triggerSecret || undefined } : {}),
				};
			}
		} catch { /* silent */ }
	}

	function toggleWatch() {
		watchEnabled = !watchEnabled;
		saveWatchConfig();
	}

	async function saveWatchConfig() {
		if (!selectedName) return;
		try {
			await fetch('/api/pipelines/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: selectedName,
					watch: watchEnabled ? {
						input: watchInput,
						pattern: watchPattern || '*',
						poll_interval: Math.max(10, watchPollInterval || 60),
						enabled: true,
					} : { enabled: false },
				}),
			});
		} catch { /* silent */ }
	}

	async function toggleScheduleEnabled(name: string, enabled: boolean) {
		try {
			await fetch('/api/pipelines/schedules', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, enabled }),
			});
			const schedule = schedules.find((s) => s.name === name);
			if (schedule) schedule.scheduleEnabled = enabled;
			schedules = [...schedules];
			// Update selected schedule state too
			if (selectedSchedule && selectedSchedule.name === name) {
				selectedSchedule = { ...selectedSchedule, scheduleEnabled: enabled };
			}
		} catch { /* silent */ }
	}

	async function killRun() {
		if (!activeRunId) return;
		try {
			await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'kill', runId: activeRunId }),
			});
			running = false;
			if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
		} catch { /* silent */ }
	}

	async function runPipeline() {
		if (!selectedName) return;
		running = true;
		activeRun = null;
		expandedSteps = new Set();

		try {
			const res = await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: selectedName, inputs: inputValues, stepConfig: Object.keys(stepConfigEdits).length > 0 ? stepConfigEdits : undefined }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				running = false;
				const errorMsg = err.errors?.join('\n') || err.error || 'Pipeline failed to start';
				activeRun = { runId: '', pipelineName: selectedName, status: 'failed', startedAt: new Date().toISOString(), steps: [], events: [], stepOutput: {}, finishedAt: new Date().toISOString() } as RunResult;
				activeRun._error = errorMsg;
				return;
			}
			const data = await res.json();
			activeRunId = data.runId;

			// Poll for status
			pollInterval = setInterval(async () => {
				try {
					const statusRes = await fetch(`/api/pipelines/run?id=${data.runId}`);
					if (!statusRes.ok) return;
					const statusData = await statusRes.json();
					activeRun = statusData;

					// Auto-expand running and waiting steps + auto-scroll
					let expansionChanged = false;
					for (const e of statusData.events || []) {
						if (e.status === 'running' || e.status === 'waiting') {
							if (!expandedSteps.has(e.stepId)) {
								expandedSteps.add(e.stepId);
								expansionChanged = true;
							}
						}
					}
					if (expansionChanged) expandedSteps = new Set(expandedSteps);

					// Detect gate info from step output (JSON with _gate: true)
					for (const [stepId, output] of Object.entries(statusData.stepOutput || {})) {
						const outputStr = output as string;
						if (outputStr.includes('"_gate":true') || outputStr.includes('"_gate": true')) {
							try {
								const gateData = JSON.parse(outputStr);
								if (gateData._gate && !activeGates.has(stepId)) {
									activeGates.set(stepId, {
										type: gateData.type,
										message: gateData.message,
										question: gateData.question,
										show: gateData.show,
										options: gateData.options,
										options_from: gateData.options_from,
									});
									activeGates = new Map(activeGates);
									// Load the file to show for approval gates
									if (gateData.show) loadShowFile(stepId, gateData.show);
									// Default prompt answer for options
									if (gateData.options?.length) promptAnswers[stepId] = gateData.options[0];
								}
							} catch { /* not valid JSON gate info */ }
						}
					}

					// Clear gates for steps that are no longer waiting
					for (const [stepId] of activeGates) {
						const stepStatus = getStepStatus(stepId);
						if (stepStatus !== 'waiting') {
							activeGates.delete(stepId);
							activeGates = new Map(activeGates);
						}
					}

					if (statusData.status === 'done' || statusData.status === 'failed') {
						running = false;
						history = [statusData, ...history].slice(0, 20);
						if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
					}
				} catch { /* retry */ }
			}, 1500);
		} catch {
			running = false;
		}
	}

	async function retryFromStep(stepId: string) {
		if (!selectedName || running) return;
		running = true;
		activeRun = null;
		expandedSteps = new Set();

		try {
			const res = await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: selectedName, inputs: inputValues, resumeFrom: stepId }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				running = false;
				const errorMsg = err.errors?.join('\n') || err.error || 'Pipeline failed to start';
				activeRun = { runId: '', pipelineName: selectedName, status: 'failed', startedAt: new Date().toISOString(), steps: [], events: [], stepOutput: {}, finishedAt: new Date().toISOString() } as RunResult;
				activeRun._error = errorMsg;
				return;
			}
			const data = await res.json();
			activeRunId = data.runId;

			// Same polling as runPipeline
			pollInterval = setInterval(async () => {
				try {
					const statusRes = await fetch(`/api/pipelines/run?id=${data.runId}`);
					if (!statusRes.ok) return;
					const statusData = await statusRes.json();
					activeRun = statusData;

					let retryExpansionChanged = false;
					for (const e of statusData.events || []) {
						if ((e.status === 'running' || e.status === 'waiting') && !expandedSteps.has(e.stepId)) {
							expandedSteps.add(e.stepId);
							retryExpansionChanged = true;
						}
					}
					if (retryExpansionChanged) expandedSteps = new Set(expandedSteps);

					if (statusData.status === 'done' || statusData.status === 'failed') {
						running = false;
						history = [statusData, ...history].slice(0, 20);
						if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
					}
				} catch { /* retry */ }
			}, 1500);
		} catch {
			running = false;
		}
	}

	function toggleStep(stepId: string) {
		if (expandedSteps.has(stepId)) {
			expandedSteps.delete(stepId);
		} else {
			expandedSteps.add(stepId);
		}
		expandedSteps = new Set(expandedSteps);
	}

	function getStepStatus(stepId: string): string {
		if (!activeRun) return 'pending';
		const step = activeRun.steps?.find((s) => s.id === stepId);
		if (step) return step.status;
		for (let i = (activeRun.events || []).length - 1; i >= 0; i--) {
			if (activeRun.events[i].stepId === stepId) return activeRun.events[i].status;
		}
		return 'pending';
	}

	function buildTriggerUrl(): string {
		const base = `${webhookUrl}?name=${selectedName}`;
		if (selectedSchedule?.triggerSecret) {
			return `${base}&token=${selectedSchedule.triggerSecret}`;
		}
		return base;
	}

	let inputPayload = $derived.by(() => {
		if (!selected?.inputs?.length) return null;
		const payload: Record<string, unknown> = {};
		for (const input of selected.inputs) {
			const val = inputValues[input.name];
			payload[input.name] = val !== undefined && val !== '' ? val : (input.default ?? `<${input.name}>`);
		}
		return JSON.stringify({ inputs: payload });
	});

	let localCurl = $derived.by(() => {
		const base = `http://localhost:5173/api/pipelines/trigger?name=${selectedName}`;
		const secret = selectedSchedule?.triggerSecret ? `&token=${selectedSchedule.triggerSecret}` : '';
		if (inputPayload) {
			return `curl -X POST \\\n     -H "Content-Type: application/json" \\\n     -d '${inputPayload}' \\\n     "${base}${secret}"`;
		}
		return `curl "${base}${secret}"`;
	});

	let externalCurl = $derived.by(() => {
		const url = buildTriggerUrl();
		const id = cfClientId || '$CF_ACCESS_CLIENT_ID';
		const secret = cfClientSecret || '$CF_ACCESS_CLIENT_SECRET';
		if (inputPayload) {
			return `curl -X POST \\\n     -H "Content-Type: application/json" \\\n     -H "CF-Access-Client-Id: ${id}" \\\n     -H "CF-Access-Client-Secret: ${secret}" \\\n     -d '${inputPayload}' \\\n     "${url}"`;
		}
		return `curl -H "CF-Access-Client-Id: ${id}" \\\n     -H "CF-Access-Client-Secret: ${secret}" \\\n     "${url}"`;
	});

	function getSkipReason(stepId: string): string {
		if (!activeRun?.events) return '';
		const event = activeRun.events.find((e: StepEvent) => e.stepId === stepId && e.status === 'skipped');
		return event?.detail || '';
	}

	function getStepDuration(stepId: string): string {
		if (!activeRun?.steps) return '';
		const step = activeRun.steps.find((s) => s.id === stepId);
		if (!step?.durationMs) return '';
		if (step.durationMs < 1000) return `${step.durationMs}ms`;
		return `${(step.durationMs / 1000).toFixed(1)}s`;
	}

	function getStepOutput(stepId: string): string {
		return activeRun?.stepOutput?.[stepId] || '';
	}

	function getLastOutputPath(): string | null {
		if (!activeRun?.steps) return null;
		const doneSteps = activeRun.steps.filter((s) => s.status === 'done' && s.outputPath);
		return doneSteps.length > 0 ? doneSteps[doneSteps.length - 1].outputPath || null : null;
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function timeAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	function getBlockForStep(step: { block?: string }): BlockManifest | undefined {
		if (!step.block) return undefined;
		return installedBlocks.find(b => b.name === step.block);
	}

	function getBlockEnvStatus(block: BlockManifest): { name: string; set: boolean }[] {
		if (!block.env) return [];
		return block.env.map(e => ({
			name: e.name,
			set: envStatus.some(es => es.name === e.name && es.set),
		}));
	}

	function handleStepConfigChange(stepId: string, name: string, value: unknown) {
		if (!stepConfigEdits[stepId]) stepConfigEdits[stepId] = {};
		stepConfigEdits[stepId] = { ...stepConfigEdits[stepId], [name]: value };
	}

	async function runChain() {
		if (!selectedName) return;
		running = true;
		activeChainRun = null;

		try {
			const res = await fetch('/api/pipelines/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: selectedName, inputs: inputValues }),
			});

			if (!res.ok) {
				running = false;
				return;
			}
			const data = await res.json();
			activeRunId = data.runId;

			pollInterval = setInterval(async () => {
				try {
					const statusRes = await fetch(`/api/pipelines/run?id=${data.runId}`);
					if (!statusRes.ok) return;
					const statusData = await statusRes.json();
					if (statusData.type === 'chain') {
						activeChainRun = statusData;
					} else {
						activeRun = statusData;
					}

					if (statusData.status === 'done' || statusData.status === 'failed') {
						running = false;
						if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
					}
				} catch { /* retry */ }
			}, 1500);
		} catch {
			running = false;
		}
	}

	function retryChainNode(nodeId: string) {
		retryFromStep(nodeId);
	}

	function goToTroubleshoot(nodeId: string, error: string) {
		window.location.href = `/pipelines/builder?chain=${encodeURIComponent(selectedName)}&troubleshoot=${encodeURIComponent(nodeId)}&error=${encodeURIComponent(error)}`;
	}

</script>

<svelte:head>
	<title>Pipelines — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-3xl mx-auto flex items-center gap-3">
			{#if selected || selectedChain}
				<button onclick={back} class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to pipeline list">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
					</svg>
				</button>
				<button onclick={back} class="text-hub-muted hover:text-hub-text transition-colors cursor-pointer text-sm">Pipelines</button>
				<svg class="w-3 h-3 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				<h1 class="text-lg font-semibold text-hub-text truncate">{selected?.name || selectedChain?.name}</h1>
				{#if selectedChain}
					<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-hub-purple/10 text-hub-purple">chain</span>
				{/if}
				{#if selected?.version}
					<span class="flex-shrink-0 text-xs text-hub-dim font-mono">{selected.version}</span>
				{/if}
				<div class="flex-1"></div>
				<a
					href="/pipelines/builder?{selectedChain ? 'chain' : 'pipeline'}={encodeURIComponent(selectedName)}"
					class="text-hub-muted text-sm hover:text-hub-text transition-colors"
				>
					Edit
				</a>
				<!-- Run button in header -->
				{#if running}
					<button
						onclick={killRun}
						class="px-3 py-1.5 rounded-lg text-sm font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 transition-colors cursor-pointer"
					>
						Stop
					</button>
				{:else}
					<button
						onclick={selectedChain ? runChain : runPipeline}
						disabled={!canRun}
						class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
					>
						Run
					</button>
				{/if}
			{:else}
				<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to home">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
					</svg>
				</a>
				<div class="flex items-center gap-2">
					<img src="/logo.png" alt="Soul Hub" class="w-5 h-5" />
					<h1 class="text-lg font-semibold text-hub-text">Pipelines</h1>
				</div>
				<div class="flex-1"></div>
				<a
					href="/pipelines/builder?type=pipeline"
					class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors cursor-pointer"
				>
					+ New
				</a>
			{/if}
		</div>
	</header>

	<!-- Run status bar (only when running or just completed) -->
	{#if (selected || selectedChain) && (running || activeRun || activeChainRun)}
		<div class="flex-shrink-0 px-4 sm:px-6 py-2 border-b border-hub-border/50">
			<div class="max-w-3xl mx-auto flex items-center gap-3">
				{#if running}
					<svg class="w-3.5 h-3.5 text-hub-info animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
					</svg>
					<span class="text-xs text-hub-info">Running</span>
				{/if}

				<!-- Progress dots -->
				{#if selectedChain && activeChainRun && running}
					<div class="flex items-center gap-1 ml-1">
						{#each selectedChain.nodes as node}
							{@const nodeStatus = activeChainRun.nodes.find(n => n.id === node.id)?.status || 'pending'}
							<div class="w-2 h-2 rounded-full transition-colors
								{nodeStatus === 'done' ? 'bg-hub-cta' :
								 nodeStatus === 'running' ? 'bg-hub-info animate-pulse' :
								 nodeStatus === 'failed' ? 'bg-hub-danger' :
								 'bg-hub-border'}"></div>
						{/each}
					</div>
				{:else if runProgress && running}
					<div class="flex items-center gap-1 ml-1">
						{#each selected?.steps || [] as step}
							{@const stepStatus = activeRun ? getStepStatus(step.id) : 'pending'}
							<div class="w-2 h-2 rounded-full transition-colors
								{stepStatus === 'done' ? 'bg-hub-cta' :
								 stepStatus === 'running' ? 'bg-hub-info animate-pulse' :
								 stepStatus === 'failed' ? 'bg-hub-danger' :
								 'bg-hub-border'}"></div>
						{/each}
					</div>
				{/if}

				<!-- Completion -->
				{#if !running && (activeRun || activeChainRun)}
					{@const runResult = activeChainRun || activeRun}
					<span class="text-xs {runResult?.status === 'done' ? 'text-hub-cta' : 'text-hub-danger'}">
						{runResult?.status === 'done' ? '✓ Done' : '✗ Failed'}
					</span>
					{#if runResult?.finishedAt && runResult?.startedAt}
						<span class="text-[11px] text-hub-dim">
							{formatDuration(new Date(runResult.finishedAt).getTime() - new Date(runResult.startedAt).getTime())}
						</span>
					{/if}
				{/if}
			</div>
		</div>
	{/if}

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8" style="overflow-anchor: auto;">
		<div class="max-w-3xl mx-auto">
			{#if loading}
				<div class="text-center py-20 text-hub-muted text-sm">Loading pipelines...</div>
			{:else if !selected && !selectedChain}
				<!-- PIPELINE LIST -->
				{#if pipelines.length === 0}
					<div class="text-center py-20">
						<p class="text-hub-muted text-sm">No pipelines found</p>
						<a href="/pipelines/builder?type=pipeline" class="mt-2 text-sm text-hub-cta hover:text-hub-cta-hover transition-colors cursor-pointer">Create your first pipeline</a>
					</div>
				{:else}
					{#if pipelines.length > 10}
						<div class="relative mb-3">
							<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
							</svg>
							<input
								bind:value={pipelineFilter}
								type="text"
								placeholder="Filter..."
								class="w-full bg-transparent border border-hub-border rounded-lg pl-9 pr-3 py-2 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
							/>
						</div>
					{/if}
					{#if filteredPipelines.length === 0 && pipelineFilter}
						<p class="text-hub-dim text-xs py-6 text-center">No pipelines match "{pipelineFilter}"</p>
					{/if}
					<div class="divide-y divide-hub-border/60">
						{#each filteredPipelines as pipeline}
							{@const pipelineSchedule = schedules.find((s) => s.name === pipeline.name)}
							{@const lastRun = persistedHistory.find(h => h.pipelineName === pipeline.name)}
							<button
								onclick={() => selectPipeline(pipeline.name)}
								class="w-full text-left py-3 sm:py-3.5 hover:bg-hub-card/30 -mx-2 px-2 rounded-lg transition-colors cursor-pointer group"
							>
								<!-- Desktop: single row -->
								<div class="hidden sm:flex items-center gap-3">
									<span class="font-medium text-sm text-hub-text group-hover:text-hub-cta transition-colors truncate">
										{pipeline.name}
									</span>
									<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium {pipeline.type === 'chain' ? 'bg-hub-purple/15 text-hub-purple' : 'bg-hub-info/15 text-hub-info'}">
										{pipeline.type || 'pipeline'}
									</span>
									<span class="text-xs text-hub-dim truncate flex-1">{pipeline.description}</span>
									{#if lastRun}
										<span class="flex-shrink-0 w-2 h-2 rounded-full {lastRun.status === 'done' ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
										<span class="flex-shrink-0 text-[11px] text-hub-dim">{timeAgo(lastRun.startedAt)}</span>
									{:else}
										<span class="flex-shrink-0 w-2 h-2 rounded-full bg-hub-dim/30"></span>
										<span class="flex-shrink-0 text-[11px] text-hub-dim">never</span>
									{/if}
								</div>
								<!-- Mobile: two lines -->
								<div class="flex sm:hidden flex-col gap-1">
									<div class="flex items-center gap-2">
										<span class="font-medium text-sm text-hub-text group-hover:text-hub-cta transition-colors truncate">
											{pipeline.name}
										</span>
										<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium {pipeline.type === 'chain' ? 'bg-hub-purple/15 text-hub-purple' : 'bg-hub-info/15 text-hub-info'}">
											{pipeline.type || 'pipeline'}
										</span>
										{#if lastRun}
											<span class="ml-auto flex-shrink-0 w-2 h-2 rounded-full {lastRun.status === 'done' ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
										{/if}
									</div>
									<span class="text-[11px] text-hub-dim truncate">{pipeline.description}</span>
								</div>
							</button>
						{/each}
					</div>
				{/if}

				<!-- RUN HISTORY (compact) -->
				{#if persistedHistory.length > 0}
					<div class="mt-8 pt-6 border-t border-hub-border/40">
						<h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Recent Runs</h3>
						<div class="space-y-1">
							{#each persistedHistory.slice(0, 8) as record}
								<button
									onclick={() => selectPipeline(record.pipelineName)}
									class="w-full flex items-center gap-3 py-1.5 px-2 -mx-2 rounded-lg hover:bg-hub-card/30 transition-colors cursor-pointer text-left"
								>
									<span class="flex-shrink-0 w-2 h-2 rounded-full {record.status === 'done' ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
									<span class="text-xs text-hub-muted truncate">{record.pipelineName}</span>
									<span class="text-[11px] text-hub-dim ml-auto flex-shrink-0">{timeAgo(record.startedAt)}</span>
									{#if record.finishedAt && record.startedAt}
										<span class="text-[11px] text-hub-dim flex-shrink-0">{formatDuration(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime())}</span>
									{/if}
								</button>
							{/each}
						</div>
					</div>
				{/if}

			{:else if selectedChain}
				<!-- CHAIN DETAIL -->
				<p class="text-sm text-hub-muted mb-6">{selectedChain.description}</p>

				<!-- Settings (collapsible) -->
				{#if selectedSchedule}
					<section class="mb-6">
						<button
							onclick={() => { showSettings = !showSettings; }}
							class="flex items-center gap-2 text-xs font-medium text-hub-dim uppercase tracking-wider mb-3 cursor-pointer hover:text-hub-muted transition-colors"
						>
							<svg class="w-3 h-3 transition-transform {showSettings ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
							Settings
							{#if selectedSchedule.schedule || selectedSchedule.triggerEnabled || watchEnabled}
								<span class="w-1.5 h-1.5 rounded-full bg-hub-cta/60"></span>
							{/if}
						</button>
						{#if showSettings}
						<div class="bg-hub-surface border border-hub-border rounded-lg p-4 space-y-3">
							<!-- Schedule -->
							<div class="flex items-center gap-3 flex-wrap">
								<span class="text-xs text-hub-muted w-16 flex-shrink-0">Schedule</span>
								{#if editingSchedule}
									<input
										type="text"
										bind:value={scheduleInput}
										placeholder="e.g. 0 8 * * * (daily 8am)"
										onkeydown={(e) => { if (e.key === 'Enter') saveSchedule(selectedName, scheduleInput || null); if (e.key === 'Escape') { editingSchedule = false; } }}
										class="flex-1 min-w-[200px] bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
									/>
									<button onclick={() => saveSchedule(selectedName, scheduleInput || null)} disabled={scheduleSaving}
										class="text-[10px] text-hub-cta hover:text-hub-cta/80 cursor-pointer">{scheduleSaving ? '...' : 'Save'}</button>
									<button onclick={() => { editingSchedule = false; }}
										class="text-[10px] text-hub-dim hover:text-hub-muted cursor-pointer">Cancel</button>
								{:else if selectedSchedule.schedule}
									<span class="text-xs font-mono text-hub-text bg-hub-bg px-2 py-1 rounded">{selectedSchedule.schedule}</span>
									<button
										onclick={() => toggleScheduleEnabled(selectedName, !selectedSchedule!.scheduleEnabled)}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{selectedSchedule.scheduleEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{selectedSchedule.scheduleEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {selectedSchedule.scheduleEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{selectedSchedule.scheduleEnabled ? 'Active' : 'Paused'}
									</span>
									<button onclick={() => { editingSchedule = true; scheduleInput = selectedSchedule?.schedule || ''; }}
										class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer ml-auto">Edit</button>
									<button onclick={() => saveSchedule(selectedName, null)}
										class="text-[10px] text-hub-danger hover:text-hub-danger/80 cursor-pointer">Remove</button>
								{:else}
									<button onclick={() => { editingSchedule = true; scheduleInput = ''; }}
										class="text-xs text-hub-info hover:text-hub-info/80 cursor-pointer">+ Add schedule</button>
								{/if}
							</div>

							<!-- Webhook trigger -->
							<div class="space-y-2">
								<div class="flex items-center gap-3">
									<span class="text-xs text-hub-muted w-16 flex-shrink-0">Trigger</span>
									<button
										onclick={() => saveTriggerConfig(selectedName, { triggerEnabled: !selectedSchedule!.triggerEnabled })}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{selectedSchedule.triggerEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{selectedSchedule.triggerEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {selectedSchedule.triggerEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{selectedSchedule.triggerEnabled ? 'Enabled' : 'Disabled'}
									</span>
								</div>

								{#if selectedSchedule.triggerEnabled}
									<div class="ml-[76px] space-y-2">
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">URL</span>
											<code class="text-[10px] font-mono text-hub-text bg-hub-bg px-2 py-1 rounded flex-1 select-all truncate">{buildTriggerUrl()}</code>
											<button onclick={() => navigator.clipboard.writeText(buildTriggerUrl())}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer">Copy</button>
										</div>
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Secret</span>
											{#if editingSecret}
												<input
													type="text"
													bind:value={secretInput}
													placeholder="Enter a secret token"
													onkeydown={(e) => {
														if (e.key === 'Enter') { saveTriggerConfig(selectedName, { triggerSecret: secretInput || null }); editingSecret = false; }
														if (e.key === 'Escape') editingSecret = false;
													}}
													class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
												/>
												<button onclick={() => { saveTriggerConfig(selectedName, { triggerSecret: secretInput || null }); editingSecret = false; }}
													class="text-[10px] text-hub-cta cursor-pointer">Save</button>
												<button onclick={() => editingSecret = false}
													class="text-[10px] text-hub-dim cursor-pointer">Cancel</button>
											{:else if selectedSchedule.triggerSecret}
												<code class="text-[10px] font-mono text-hub-dim bg-hub-bg px-2 py-1 rounded">{'*'.repeat(selectedSchedule.triggerSecret.length)}</code>
												<button onclick={() => { editingSecret = true; secretInput = selectedSchedule?.triggerSecret || ''; }}
													class="text-[10px] text-hub-info cursor-pointer">Edit</button>
												<button onclick={() => saveTriggerConfig(selectedName, { triggerSecret: null })}
													class="text-[10px] text-hub-danger cursor-pointer">Remove</button>
											{:else}
												<button onclick={() => { editingSecret = true; secretInput = ''; }}
													class="text-[10px] text-hub-info cursor-pointer">+ Add secret</button>
												<span class="text-[9px] text-hub-dim italic">optional — anyone with the URL can trigger</span>
											{/if}
										</div>
										{#if selectedChain.inputs?.length}
											<div class="flex items-start gap-2 pt-1.5 border-t border-hub-border/30">
												<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Payload</span>
												<div class="flex-1 bg-hub-bg rounded px-2 py-1.5 space-y-1">
													{#each selectedChain.inputs as input}
														<div class="flex items-center gap-2 text-[10px]">
															<span class="font-mono text-hub-info">{input.name}</span>
															<span class="text-hub-dim">({input.type}){input.required !== false ? '' : ' optional'}</span>
															{#if inputValues[input.name]}
																<span class="text-hub-muted ml-auto font-mono">= "{inputValues[input.name]}"</span>
															{:else if input.default !== undefined}
																<span class="text-hub-dim ml-auto font-mono">default: "{input.default}"</span>
															{/if}
														</div>
													{/each}
												</div>
											</div>
										{/if}
										<div class="flex items-start gap-2 pt-1.5 border-t border-hub-border/30">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Local</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{localCurl}</pre>
											<button onclick={() => navigator.clipboard.writeText(localCurl)}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
										<div class="flex items-start gap-2">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Remote</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{externalCurl}</pre>
											<button onclick={() => navigator.clipboard.writeText(externalCurl)}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
									</div>
								{/if}
							</div>

							<!-- Folder Watch -->
							<div class="space-y-2 pt-2 border-t border-hub-border/30">
								<div class="flex items-center gap-3">
									<span class="text-xs text-hub-muted w-16 flex-shrink-0">Watch</span>
									<button
										onclick={() => toggleWatch()}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{watchEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{watchEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {watchEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{watchEnabled ? 'Watching' : 'Disabled'}
									</span>
									{#if watchEnabled && watchStatus}
										<span class="text-[10px] text-hub-muted ml-auto">
											{watchStatus.inProgress.length > 0
												? `Processing ${watchStatus.inProgress.length} file${watchStatus.inProgress.length > 1 ? 's' : ''}...`
												: `${watchStatus.history.length > 0 ? 'Idle' : 'Waiting for files'}`}
										</span>
									{/if}
								</div>

								{#if watchEnabled}
									<div class="ml-[76px] space-y-2">
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Input</span>
											<select
												bind:value={watchInput}
												onchange={() => saveWatchConfig()}
												class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 cursor-pointer"
											>
												<option value="">Select folder input...</option>
												{#each folderInputs as fi}
													<option value={fi.name}>{fi.name} — {fi.description}</option>
												{/each}
											</select>
										</div>

										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Pattern</span>
											<input
												type="text"
												bind:value={watchPattern}
												placeholder="*.csv"
												onchange={() => saveWatchConfig()}
												class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
											/>
										</div>

										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Poll</span>
											<input
												type="number"
												bind:value={watchPollInterval}
												min="10"
												max="3600"
												onchange={() => saveWatchConfig()}
												class="w-20 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
											/>
											<span class="text-[10px] text-hub-dim">seconds</span>
										</div>

										{#if watchStatus?.history && watchStatus.history.length > 0}
											<div class="pt-1.5 border-t border-hub-border/30">
												<span class="text-[10px] text-hub-dim">Recent:</span>
												<div class="mt-1 space-y-0.5">
													{#each watchStatus.history.slice(0, 3) as item}
														<div class="flex items-center gap-2 text-[10px]">
															<span class="{item.status === 'processed' ? 'text-hub-cta' : 'text-hub-danger'}">
																{item.status === 'processed' ? '✓' : '✗'}
															</span>
															<span class="text-hub-muted font-mono truncate flex-1">{item.filename}</span>
															<span class="text-hub-dim">{timeAgo(item.timestamp)}</span>
														</div>
													{/each}
												</div>
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</div>
						{/if}
					</section>
				{/if}

				<!-- Chain inputs form -->
				{#if selectedChain.inputs && selectedChain.inputs.length > 0}
					<section class="mb-6">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Configuration</h2>
						<div class="bg-hub-surface border border-hub-border rounded-lg p-4 space-y-3">
							{#each selectedChain.inputs as input}
								{@const isEmpty = inputValues[input.name] === undefined || inputValues[input.name] === '' || inputValues[input.name] === null}
								{@const isRequired = input.required !== false}
								{@const showError = isRequired && isEmpty}
								<div>
									<div class="flex items-center justify-between mb-1">
										<label for="chain-input-{input.name}" class="text-xs text-hub-muted">{input.description}</label>
										{#if isRequired}
											<span class="text-[9px] {showError ? 'text-hub-danger' : 'text-hub-dim'}">required</span>
										{/if}
									</div>
									{#if input.type === 'select' && input.options}
										<select
											id="chain-input-{input.name}"
											bind:value={inputValues[input.name]}
											class="w-full bg-hub-bg border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 cursor-pointer
												{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
										>
											{#each input.options as opt}
												<option value={opt}>{opt}</option>
											{/each}
										</select>
									{:else if input.type === 'file' || input.type === 'path'}
										{@const pathVal = String(inputValues[input.name] || '')}
										{@const pathStatus = filePathStatus[input.name]}
										<div class="relative">
											<div class="absolute left-3 top-1/2 -translate-y-1/2 text-hub-dim pointer-events-none">
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
												</svg>
											</div>
											<input
												id="chain-input-{input.name}"
												type="text"
												bind:value={inputValues[input.name]}
												placeholder={input.default !== undefined ? String(input.default) : '/path/to/file'}
												oninput={() => validateFilePath(input.name, String(inputValues[input.name] || ''))}
												class="w-full bg-hub-bg border rounded-md pl-9 pr-8 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
													{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
											/>
											{#if pathVal && pathStatus !== undefined}
												<div class="absolute right-3 top-1/2 -translate-y-1/2">
													{#if pathStatus === 'valid'}
														<svg class="w-3.5 h-3.5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
													{:else if pathStatus === 'invalid'}
														<svg class="w-3.5 h-3.5 text-hub-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
													{:else if pathStatus === 'checking'}
														<svg class="w-3.5 h-3.5 text-hub-dim animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
													{/if}
												</div>
											{/if}
										</div>
										{#if pathVal && pathStatus === 'invalid'}
											<p class="text-[10px] text-hub-danger mt-0.5">File not found</p>
										{/if}
									{:else if input.type === 'folder'}
										{@const pathVal = String(inputValues[input.name] || '')}
										{@const pathStatus = filePathStatus[input.name]}
										{@const folderFiles = folderFileCount[input.name]}
										<div class="relative">
											<div class="absolute left-3 top-1/2 -translate-y-1/2 text-hub-dim pointer-events-none">
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
													<line x1="12" y1="11" x2="12" y2="17"/>
													<line x1="9" y1="14" x2="15" y2="14"/>
												</svg>
											</div>
											<input
												id="chain-input-{input.name}"
												type="text"
												bind:value={inputValues[input.name]}
												placeholder={input.default !== undefined ? String(input.default) : '/path/to/folder'}
												oninput={() => validateFolderPath(input.name, String(inputValues[input.name] || ''))}
												class="w-full bg-hub-bg border rounded-md pl-9 pr-8 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
													{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
											/>
											{#if pathVal && pathStatus !== undefined}
												<div class="absolute right-3 top-1/2 -translate-y-1/2">
													{#if pathStatus === 'valid'}
														<svg class="w-3.5 h-3.5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
													{:else if pathStatus === 'invalid'}
														<svg class="w-3.5 h-3.5 text-hub-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
													{:else if pathStatus === 'checking'}
														<svg class="w-3.5 h-3.5 text-hub-dim animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
													{/if}
												</div>
											{/if}
										</div>
										{#if pathVal && pathStatus === 'valid' && folderFiles !== undefined}
											<p class="text-[10px] text-hub-cta mt-0.5">{folderFiles} file{folderFiles !== 1 ? 's' : ''} in folder</p>
										{:else if pathVal && pathStatus === 'invalid'}
											<p class="text-[10px] text-hub-danger mt-0.5">Folder not found</p>
										{/if}
									{:else}
										<input
											id="chain-input-{input.name}"
											type="text"
											bind:value={inputValues[input.name]}
											placeholder={input.default !== undefined ? String(input.default) : ''}
											class="w-full bg-hub-bg border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
												{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
										/>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- Node Flow -->
				<section class="mb-6">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Nodes</h2>
					<ChainNodeFlow
						nodes={selectedChain.nodes}
						nodeDetails={chainNodeDetails}
						activeRun={activeChainRun}
						onRetryNode={(nodeId) => retryChainNode(nodeId)}
						onTroubleshoot={(nodeId, error) => goToTroubleshoot(nodeId, error)}
					/>
				</section>

				<!-- Chain Outputs (shown after a completed run) -->
				{#if activeChainRun && (activeChainRun.status === 'done' || activeChainRun.status === 'failed')}
					{@const completedNodes = activeChainRun.nodes.filter(n => n.status === 'done' && n.outputPath)}
					{#if completedNodes.length > 0}
						<section class="mb-6">
							<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Outputs</h2>
							<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden divide-y divide-hub-border/30">
								{#each completedNodes as node}
									{@const fileName = node.outputPath?.split('/').pop() || ''}
									{@const pipelineDir = `pipelines/${node.pipelineName}/output`}
									<button
										onclick={() => { previewFile = { path: node.outputPath || '', name: `${node.id}: ${fileName}` }; }}
										class="w-full flex items-center gap-3 px-4 py-3 hover:bg-hub-bg/30 transition-colors cursor-pointer text-left"
									>
										<svg class="w-3.5 h-3.5 flex-shrink-0 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
										</svg>
										<div class="flex-1 min-w-0">
											<span class="text-sm text-hub-text">{fileName}</span>
											<span class="text-[10px] text-hub-dim ml-2">from {node.id}</span>
										</div>
										{#if node.pipelineRun}
											<span class="text-[10px] text-hub-dim">{node.pipelineRun.steps.filter(s => s.status === 'done').length} steps</span>
										{/if}
									</button>
								{/each}
							</div>
						</section>
					{/if}
				{/if}

			{:else if selected}
				<!-- PIPELINE DETAIL + RUN -->
				<p class="text-sm text-hub-muted mb-6">{selected.description}</p>

				<!-- Settings (collapsible) -->
				{#if selectedSchedule}
					<section class="mb-6">
						<button
							onclick={() => { showSettings = !showSettings; }}
							class="flex items-center gap-2 text-xs font-medium text-hub-dim uppercase tracking-wider mb-3 cursor-pointer hover:text-hub-muted transition-colors"
						>
							<svg class="w-3 h-3 transition-transform {showSettings ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
							Settings
							{#if selectedSchedule.schedule || selectedSchedule.triggerEnabled || watchEnabled}
								<span class="w-1.5 h-1.5 rounded-full bg-hub-cta/60"></span>
							{/if}
						</button>
						{#if showSettings}
						<div class="bg-hub-surface border border-hub-border rounded-lg p-4 space-y-3">
							<!-- Schedule -->
							<div class="flex items-center gap-3 flex-wrap">
								<span class="text-xs text-hub-muted w-16 flex-shrink-0">Schedule</span>
								{#if editingSchedule}
									<input
										type="text"
										bind:value={scheduleInput}
										placeholder="e.g. 0 8 * * * (daily 8am)"
										onkeydown={(e) => { if (e.key === 'Enter') saveSchedule(selectedName, scheduleInput || null); if (e.key === 'Escape') { editingSchedule = false; } }}
										class="flex-1 min-w-[200px] bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
									/>
									<button onclick={() => saveSchedule(selectedName, scheduleInput || null)} disabled={scheduleSaving}
										class="text-[10px] text-hub-cta hover:text-hub-cta/80 cursor-pointer">{scheduleSaving ? '...' : 'Save'}</button>
									<button onclick={() => { editingSchedule = false; }}
										class="text-[10px] text-hub-dim hover:text-hub-muted cursor-pointer">Cancel</button>
								{:else if selectedSchedule.schedule}
									<span class="text-xs font-mono text-hub-text bg-hub-bg px-2 py-1 rounded">{selectedSchedule.schedule}</span>
									<button
										onclick={() => toggleScheduleEnabled(selectedName, !selectedSchedule!.scheduleEnabled)}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{selectedSchedule.scheduleEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{selectedSchedule.scheduleEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {selectedSchedule.scheduleEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{selectedSchedule.scheduleEnabled ? 'Active' : 'Paused'}
									</span>
									<button onclick={() => { editingSchedule = true; scheduleInput = selectedSchedule?.schedule || ''; }}
										class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer ml-auto">Edit</button>
									<button onclick={() => saveSchedule(selectedName, null)}
										class="text-[10px] text-hub-danger hover:text-hub-danger/80 cursor-pointer">Remove</button>
								{:else}
									<button onclick={() => { editingSchedule = true; scheduleInput = ''; }}
										class="text-xs text-hub-info hover:text-hub-info/80 cursor-pointer">+ Add schedule</button>
								{/if}
							</div>

							<!-- Webhook trigger -->
							<div class="space-y-2">
								<div class="flex items-center gap-3">
									<span class="text-xs text-hub-muted w-16 flex-shrink-0">Trigger</span>
									<button
										onclick={() => saveTriggerConfig(selectedName, { triggerEnabled: !selectedSchedule!.triggerEnabled })}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{selectedSchedule.triggerEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{selectedSchedule.triggerEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {selectedSchedule.triggerEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{selectedSchedule.triggerEnabled ? 'Enabled' : 'Disabled'}
									</span>
								</div>

								{#if selectedSchedule.triggerEnabled}
									<div class="ml-[76px] space-y-2">
										<!-- URL -->
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">URL</span>
											<code class="text-[10px] font-mono text-hub-text bg-hub-bg px-2 py-1 rounded flex-1 select-all truncate">{buildTriggerUrl()}</code>
											<button onclick={() => navigator.clipboard.writeText(buildTriggerUrl())}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer">Copy</button>
										</div>
										<!-- Secret -->
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Secret</span>
											{#if editingSecret}
												<input
													type="text"
													bind:value={secretInput}
													placeholder="Enter a secret token"
													onkeydown={(e) => {
														if (e.key === 'Enter') { saveTriggerConfig(selectedName, { triggerSecret: secretInput || null }); editingSecret = false; }
														if (e.key === 'Escape') editingSecret = false;
													}}
													class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
												/>
												<button onclick={() => { saveTriggerConfig(selectedName, { triggerSecret: secretInput || null }); editingSecret = false; }}
													class="text-[10px] text-hub-cta cursor-pointer">Save</button>
												<button onclick={() => editingSecret = false}
													class="text-[10px] text-hub-dim cursor-pointer">Cancel</button>
											{:else if selectedSchedule.triggerSecret}
												<code class="text-[10px] font-mono text-hub-dim bg-hub-bg px-2 py-1 rounded">{'*'.repeat(selectedSchedule.triggerSecret.length)}</code>
												<button onclick={() => { editingSecret = true; secretInput = selectedSchedule?.triggerSecret || ''; }}
													class="text-[10px] text-hub-info cursor-pointer">Edit</button>
												<button onclick={() => saveTriggerConfig(selectedName, { triggerSecret: null })}
													class="text-[10px] text-hub-danger cursor-pointer">Remove</button>
											{:else}
												<button onclick={() => { editingSecret = true; secretInput = ''; }}
													class="text-[10px] text-hub-info cursor-pointer">+ Add secret</button>
												<span class="text-[9px] text-hub-dim italic">optional — anyone with the URL can trigger</span>
											{/if}
										</div>
										<!-- Payload schema (when pipeline has inputs) -->
										{#if selected?.inputs?.length}
											<div class="flex items-start gap-2 pt-1.5 border-t border-hub-border/30">
												<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Payload</span>
												<div class="flex-1 bg-hub-bg rounded px-2 py-1.5 space-y-1">
													{#each selected.inputs as input}
														<div class="flex items-center gap-2 text-[10px]">
															<span class="font-mono text-hub-info">{input.name}</span>
															<span class="text-hub-dim">({input.type}){input.required !== false ? '' : ' optional'}</span>
															{#if inputValues[input.name]}
																<span class="text-hub-muted ml-auto font-mono">= "{inputValues[input.name]}"</span>
															{:else if input.default !== undefined}
																<span class="text-hub-dim ml-auto font-mono">default: "{input.default}"</span>
															{/if}
														</div>
													{/each}
													<p class="text-[9px] text-hub-dim mt-1">Curl commands below use current input values as JSON body</p>
												</div>
											</div>
										{/if}
										<!-- Test curl — local -->
										<div class="flex items-start gap-2 pt-1.5 border-t border-hub-border/30">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Local</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{localCurl}</pre>
											<button onclick={() => navigator.clipboard.writeText(localCurl)}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
										<!-- Test curl — external (via Cloudflare Access) -->
										<div class="flex items-start gap-2">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Remote</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{externalCurl}</pre>
											<button onclick={() => navigator.clipboard.writeText(externalCurl)}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
									</div>
								{/if}
							</div>

							<!-- Folder Watch -->
							<div class="space-y-2 pt-2 border-t border-hub-border/30">
								<div class="flex items-center gap-3">
									<span class="text-xs text-hub-muted w-16 flex-shrink-0">Watch</span>
									<button
										onclick={() => toggleWatch()}
										class="w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 relative
											{watchEnabled ? 'bg-hub-cta' : 'bg-hub-border'}"
									>
										<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
											{watchEnabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<span class="text-[10px] {watchEnabled ? 'text-hub-cta' : 'text-hub-dim'}">
										{watchEnabled ? 'Watching' : 'Disabled'}
									</span>
									{#if watchEnabled && watchStatus}
										<span class="text-[10px] text-hub-muted ml-auto">
											{watchStatus.inProgress.length > 0
												? `Processing ${watchStatus.inProgress.length} file${watchStatus.inProgress.length > 1 ? 's' : ''}...`
												: `${watchStatus.history.length > 0 ? 'Idle' : 'Waiting for files'}`}
										</span>
									{/if}
								</div>

								{#if watchEnabled}
									<div class="ml-[76px] space-y-2">
										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Input</span>
											<select
												bind:value={watchInput}
												onchange={() => saveWatchConfig()}
												class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 cursor-pointer"
											>
												<option value="">Select folder input...</option>
												{#each folderInputs as fi}
													<option value={fi.name}>{fi.name} — {fi.description}</option>
												{/each}
											</select>
										</div>

										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Pattern</span>
											<input
												type="text"
												bind:value={watchPattern}
												placeholder="*.csv"
												onchange={() => saveWatchConfig()}
												class="flex-1 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
											/>
										</div>

										<div class="flex items-center gap-2">
											<span class="text-[10px] text-hub-dim w-12">Poll</span>
											<input
												type="number"
												bind:value={watchPollInterval}
												min="10"
												max="3600"
												onchange={() => saveWatchConfig()}
												class="w-20 bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-[10px] text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
											/>
											<span class="text-[10px] text-hub-dim">seconds</span>
										</div>

										{#if watchStatus?.history && watchStatus.history.length > 0}
											<div class="pt-1.5 border-t border-hub-border/30">
												<span class="text-[10px] text-hub-dim">Recent:</span>
												<div class="mt-1 space-y-0.5">
													{#each watchStatus.history.slice(0, 3) as item}
														<div class="flex items-center gap-2 text-[10px]">
															<span class="{item.status === 'processed' ? 'text-hub-cta' : 'text-hub-danger'}">
																{item.status === 'processed' ? '✓' : '✗'}
															</span>
															<span class="text-hub-muted font-mono truncate flex-1">{item.filename}</span>
															<span class="text-hub-dim">{timeAgo(item.timestamp)}</span>
														</div>
													{/each}
												</div>
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</div>

						<!-- Shared Config (inside settings) -->
						{#if selected.config_files && selected.config_files.length > 0}
							<div class="mt-4 pt-3 border-t border-hub-border/30">
								<h3 class="text-[10px] font-medium text-hub-dim uppercase tracking-wider mb-2">Shared Config</h3>
								<div class="space-y-3">
									{#each selected.config_files as cfg}
										<SharedConfigEditor
											pipelineName={selectedName}
											configFile={{ name: cfg.name, file: cfg.path, description: cfg.description, columns: cfg.columns }}
										/>
									{/each}
								</div>
							</div>
						{/if}
						{/if}
					</section>
				{/if}

				<!-- Env var banner -->
				{#if missingEnvVars.length > 0}
					<div class="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-hub-warning/5 border border-hub-warning/30 text-xs text-hub-warning">
						<span>!</span>
						<span>{missingEnvVars.length} env var{missingEnvVars.length > 1 ? 's' : ''} missing</span>
						<a href="/settings" class="ml-auto text-[11px] text-hub-info hover:underline cursor-pointer">Fix</a>
					</div>
				{/if}

				<!-- Inputs form -->
				{#if selected.inputs && selected.inputs.length > 0}
					<section class="mb-6">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Configuration</h2>
						<div class="bg-hub-surface border border-hub-border rounded-lg p-4 space-y-3">
							{#each selected.inputs as input}
								{@const isEmpty = inputValues[input.name] === undefined || inputValues[input.name] === '' || inputValues[input.name] === null}
								{@const isRequired = input.required !== false}
								{@const showError = isRequired && isEmpty}
								<div>
									<div class="flex items-center justify-between mb-1">
										<label for="input-{input.name}" class="text-xs text-hub-muted">{input.description}</label>
										{#if isRequired}
											<span class="text-[9px] {showError ? 'text-hub-danger' : 'text-hub-dim'}">required</span>
										{/if}
									</div>
									{#if input.type === 'select' && input.options}
										<select
											id="input-{input.name}"
											bind:value={inputValues[input.name]}
											class="w-full bg-hub-bg border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 cursor-pointer
												{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
										>
											{#each input.options as opt}
												<option value={opt}>{opt}</option>
											{/each}
										</select>
									{:else if input.type === 'file' || input.type === 'path'}
										{@const pathVal = String(inputValues[input.name] || '')}
										{@const pathStatus = filePathStatus[input.name]}
										<div class="relative">
											<div class="absolute left-3 top-1/2 -translate-y-1/2 text-hub-dim pointer-events-none">
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
												</svg>
											</div>
											<input
												id="input-{input.name}"
												type="text"
												bind:value={inputValues[input.name]}
												placeholder={input.default !== undefined ? String(input.default) : '/path/to/file'}
												oninput={() => validateFilePath(input.name, String(inputValues[input.name] || ''))}
												class="w-full bg-hub-bg border rounded-md pl-9 pr-8 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
													{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
											/>
											{#if pathVal && pathStatus !== undefined}
												<div class="absolute right-3 top-1/2 -translate-y-1/2">
													{#if pathStatus === 'valid'}
														<svg class="w-3.5 h-3.5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
													{:else if pathStatus === 'invalid'}
														<svg class="w-3.5 h-3.5 text-hub-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
													{:else if pathStatus === 'checking'}
														<svg class="w-3.5 h-3.5 text-hub-dim animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
													{/if}
												</div>
											{/if}
										</div>
										{#if pathVal && pathStatus === 'invalid'}
											<p class="text-[10px] text-hub-danger mt-0.5">File not found</p>
										{/if}
									{:else if input.type === 'folder'}
										{@const pathVal = String(inputValues[input.name] || '')}
										{@const pathStatus = filePathStatus[input.name]}
										{@const folderFiles = folderFileCount[input.name]}
										<div class="relative">
											<div class="absolute left-3 top-1/2 -translate-y-1/2 text-hub-dim pointer-events-none">
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
													<line x1="12" y1="11" x2="12" y2="17"/>
													<line x1="9" y1="14" x2="15" y2="14"/>
												</svg>
											</div>
											<input
												id="input-{input.name}"
												type="text"
												bind:value={inputValues[input.name]}
												placeholder={input.default !== undefined ? String(input.default) : '/path/to/folder'}
												oninput={() => validateFolderPath(input.name, String(inputValues[input.name] || ''))}
												class="w-full bg-hub-bg border rounded-md pl-9 pr-8 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
													{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
											/>
											{#if pathVal && pathStatus !== undefined}
												<div class="absolute right-3 top-1/2 -translate-y-1/2">
													{#if pathStatus === 'valid'}
														<svg class="w-3.5 h-3.5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
													{:else if pathStatus === 'invalid'}
														<svg class="w-3.5 h-3.5 text-hub-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
													{:else if pathStatus === 'checking'}
														<svg class="w-3.5 h-3.5 text-hub-dim animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
													{/if}
												</div>
											{/if}
										</div>
										{#if pathVal && pathStatus === 'valid' && folderFiles !== undefined}
											<p class="text-[10px] text-hub-cta mt-0.5">{folderFiles} file{folderFiles !== 1 ? 's' : ''} in folder</p>
										{:else if pathVal && pathStatus === 'invalid'}
											<p class="text-[10px] text-hub-danger mt-0.5">Folder not found</p>
										{/if}
									{:else}
										<input
											id="input-{input.name}"
											type="text"
											bind:value={inputValues[input.name]}
											placeholder={input.default !== undefined ? String(input.default) : ''}
											class="w-full bg-hub-bg border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1
												{showError ? 'border-hub-danger/50 focus:ring-hub-danger/50' : 'border-hub-border focus:ring-hub-info/50'}"
										/>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- Steps overview -->
				<section class="mb-6">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Steps</h2>

					<div class="divide-y divide-hub-border/40">
						{#each selected.steps as step, i}
							{@const status = activeRun ? getStepStatus(step.id) : 'pending'}
							{@const duration = getStepDuration(step.id)}
							{@const output = getStepOutput(step.id)}
							{@const isExpanded = expandedSteps.has(step.id)}
							{@const block = getBlockForStep(step)}
							{@const stepType = step.block ? (block?.type || 'script') : step.type}

							<div id="step-{step.id}">
								<!-- Step row header (unified for all step types) -->
								<button
									onclick={() => toggleStep(step.id)}
									class="w-full flex items-center gap-3 py-3 px-1 cursor-pointer hover:bg-hub-card/20 -mx-1 rounded-lg transition-colors"
								>
									<span class="flex-shrink-0 text-sm {statusColor[status]} {status === 'running' ? 'animate-pulse' : ''}">
										{statusIcon[status]}
									</span>
									<span class="text-sm font-mono font-medium text-hub-text">{step.id}</span>
									<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium
										{stepType === 'agent' ? 'bg-hub-purple/10 text-hub-purple' :
										 stepType === 'approval' ? 'bg-hub-warning/10 text-hub-warning' :
										 stepType === 'prompt' ? 'bg-hub-info/10 text-hub-info' :
										 'bg-hub-info/10 text-hub-info'}">
										{stepType}
									</span>
									{#if duration}
										<span class="text-[11px] text-hub-dim">{duration}</span>
									{/if}
									{#if status === 'skipped'}
										<span class="text-[10px] text-hub-dim italic">skipped</span>
									{/if}
									<svg class="w-3 h-3 text-hub-dim ml-auto flex-shrink-0 transition-transform {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
								</button>

								<!-- Expanded content (shared for all step types) -->
								{#if isExpanded}
									{@const gate = activeGates.get(step.id)}
									{@const isSubmitting = gateSubmitting.has(step.id)}
									<div class="pb-3 space-y-0">
										<!-- Block config (only for block-backed steps, before run) -->
										{#if step.block && block && !activeRun}
											<div class="mb-2">
												<StepConfigCard
													{step}
													{block}
													configValues={stepConfigEdits[step.id] || {}}
													envStatus={block ? getBlockEnvStatus(block) : []}
													expanded={true}
													ontoggle={toggleStep}
													onconfigchange={handleStepConfigChange}
												/>
											</div>
										{/if}

										<!-- Gate: approval -->
										{#if gate && status === 'waiting'}
											{#if gate.type === 'approval'}
												<div class="bg-hub-warning/5 rounded-lg px-4 py-3 mx-1">
													<p class="text-sm text-hub-text mb-3">{gate.message || 'Review and approve to continue'}</p>
													{#if showFileContent[step.id]}
														<pre class="text-xs font-mono text-hub-muted bg-hub-bg rounded-lg px-3 py-2 mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap">{showFileContent[step.id]}</pre>
													{/if}
													<div class="flex items-center gap-2">
														<button onclick={() => handleApprove(step.id)} disabled={isSubmitting}
															class="px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-cta text-white hover:bg-hub-cta/80 cursor-pointer disabled:opacity-50">
															{isSubmitting ? '...' : 'Approve'}
														</button>
														<button onclick={() => handleReject(step.id)} disabled={isSubmitting}
															class="px-3 py-1.5 rounded-lg text-xs font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 cursor-pointer disabled:opacity-50">
															Reject
														</button>
													</div>
												</div>
											{:else if gate.type === 'prompt'}
												<div class="bg-hub-info/5 rounded-lg px-4 py-3 mx-1">
													<p class="text-sm text-hub-text mb-3">{gate.question || 'Provide input to continue'}</p>
													{#if gate.options && gate.options.length > 0}
														<div class="space-y-1.5 mb-3">
															{#each gate.options as opt}
																<label class="flex items-center gap-2 cursor-pointer text-xs text-hub-muted hover:text-hub-text">
																	<input type="radio" name="prompt-{step.id}" value={opt} checked={promptAnswers[step.id] === opt} onchange={() => { promptAnswers[step.id] = opt; }} class="accent-hub-info" />
																	{opt}
																</label>
															{/each}
														</div>
													{:else}
														<input type="text" bind:value={promptAnswers[step.id]} placeholder="Type your answer..."
															onkeydown={(e) => { if (e.key === 'Enter') handleAnswer(step.id); }}
															class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 mb-3" />
													{/if}
													<button onclick={() => handleAnswer(step.id)} disabled={isSubmitting || !promptAnswers[step.id]}
														class="px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-info text-white hover:bg-hub-info/80 cursor-pointer disabled:opacity-50">
														{isSubmitting ? '...' : 'Submit'}
													</button>
												</div>
											{/if}
										{/if}

										<!-- Chunk/loop progress -->
										{#if (step.type === 'chunk' || step.type === 'loop') && status === 'running' && output}
											{#if step.type === 'chunk'}
												{@const chunkMatch = output.match(/Chunks: (\d+)\/(\d+)/)}
												{#if chunkMatch}
													<div class="px-1 py-2">
														<div class="flex items-center gap-2 text-[10px] text-hub-muted mb-1">
															<span>Chunks {chunkMatch[1]}/{chunkMatch[2]}</span>
														</div>
														<div class="w-full h-1 bg-hub-border rounded-full overflow-hidden">
															<div class="h-full bg-hub-info rounded-full transition-all" style="width: {(parseInt(chunkMatch[1]) / parseInt(chunkMatch[2])) * 100}%"></div>
														</div>
													</div>
												{/if}
											{:else}
												{@const loopMatch = output.match(/Loop iteration (\d+)\/(\d+)/)}
												{#if loopMatch}
													<div class="px-1 py-2 text-[10px] text-hub-muted">
														Iteration {loopMatch[1]} of {loopMatch[2]}
													</div>
												{/if}
											{/if}
										{/if}

										<!-- Log output -->
										{#if output && !output.includes('"_gate":true') && (status === 'done' || status === 'failed' || status === 'running')}
											<div class="rounded-lg overflow-hidden border border-hub-border/30 mx-1">
												<LogTerminal data={output} maxHeight={isMobile ? '140px' : '240px'} />
											</div>
										{/if}

										<!-- Failed: retry + troubleshoot -->
										{#if status === 'failed'}
											{@const stepError = activeRun?.steps?.find((s) => s.id === step.id)?.error || output || 'Unknown error'}
											<div class="flex items-center gap-2 px-1 pt-2">
												<button onclick={() => retryFromStep(step.id)} disabled={running}
													class="text-xs text-hub-cta hover:text-hub-cta/80 cursor-pointer disabled:opacity-50">
													Retry from here
												</button>
												<a href="/pipelines/builder?pipeline={encodeURIComponent(selectedName)}&troubleshoot={encodeURIComponent(step.id)}&error={encodeURIComponent(stepError)}"
													class="text-xs text-hub-danger hover:text-hub-danger/80">
													Troubleshoot
												</a>
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>

				<!-- Run error detail (if any) -->
				{#if activeRun && !running && activeRun._error}
					<div class="mb-6">
						<pre class="text-xs text-hub-danger bg-hub-danger/5 border border-hub-danger/20 rounded-md px-3 py-2 whitespace-pre-wrap">{activeRun._error}</pre>
					</div>
				{/if}

				<!-- Structured output viewer -->
				{#if activeRun?.status === 'done' && runOutputs.length > 0}
					<OutputViewer outputs={runOutputs} onPreview={(path, name) => { previewFile = { path, name }; }} />
				{/if}

				<!-- Fix Requests -->
				{#if fixRequests.length > 0}
					<section class="mt-6">
						<h2 class="text-xs font-medium text-hub-danger uppercase tracking-wider mb-3 flex items-center gap-1.5">
							<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
							</svg>
							Fix Requests ({fixRequests.length})
						</h2>
						{#each fixRequests as req}
							<div class="bg-hub-danger/5 border border-hub-danger/20 rounded-lg p-4 mb-3">
								<div class="flex items-center justify-between mb-2">
									<span class="text-xs font-medium text-hub-danger">{req.name}</span>
									<button
										onclick={() => navigator.clipboard.writeText(req.content)}
										class="px-2 py-1 rounded text-[10px] font-medium text-hub-muted border border-hub-border hover:bg-hub-card transition-colors cursor-pointer"
									>
										Copy
									</button>
								</div>
								<pre class="text-[11px] text-hub-muted bg-hub-bg rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-60">{req.content}</pre>
							</div>
						{/each}
					</section>
				{/if}

				<!-- Run History (compact, in detail view) -->
				{@const pipelineHistory = persistedHistory.filter(h => h.pipelineName === selectedName).slice(0, 5)}
				{#if pipelineHistory.length > 0}
					<section class="mt-8">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">History</h2>
						<div class="space-y-1">
							{#each pipelineHistory as record}
								<div class="flex items-center gap-3 py-1.5 px-2 -mx-2 rounded-lg text-xs">
									<span class="flex-shrink-0 w-2 h-2 rounded-full {record.status === 'done' ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
									<span class="text-hub-dim">{timeAgo(record.startedAt)}</span>
									<span class="text-hub-muted">{record.status}</span>
									{#if record.finishedAt && record.startedAt}
										<span class="text-hub-dim ml-auto">{formatDuration(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime())}</span>
									{/if}
								</div>
								{#if record.status === 'done'}
									{@const outputs = record.stepSummary.filter(s => s.outputPath)}
									{#if outputs.length > 0}
										<div class="ml-7 mb-1 space-y-0.5">
											{#each outputs as step}
												<button
													onclick={() => { previewFile = { path: step.outputPath!, name: `${step.id}: ${step.outputPath!.split('/').pop()}` }; }}
													class="flex items-center gap-2 py-0.5 text-[11px] text-hub-muted hover:text-hub-text transition-colors cursor-pointer"
												>
													<svg class="w-3 h-3 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
														<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
													</svg>
													<span class="truncate">{step.id}: {step.outputPath!.split('/').pop()}</span>
												</button>
											{/each}
										</div>
									{/if}
								{/if}
							{/each}
						</div>
					</section>
				{/if}

			{/if}
		</div>
	</div>
</div>

<!-- File preview slide-over -->
{#if previewFile}
	<FilePreview
		filePath={previewFile.path}
		fileName={previewFile.name}
		onClose={() => { previewFile = null; }}
	/>
{/if}
