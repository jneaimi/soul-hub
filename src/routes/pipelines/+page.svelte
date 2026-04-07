<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';
	import StepConfigCard from '$lib/components/StepConfigCard.svelte';
	import SharedConfigEditor from '$lib/components/SharedConfigEditor.svelte';
	import type { ConfigFieldType } from '$lib/pipeline/block';

	interface Pipeline {
		name: string;
		path: string;
		description: string;
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
	}

	// Page state
	let pipelines = $state<Pipeline[]>([]);
	let loading = $state(true);

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

	// Output browser
	let outputDir = $state<string | null>(null);
	let outputFiles = $state<{ name: string; type: string; size?: number }[]>([]);
	let previewFile = $state<{ path: string; name: string } | null>(null);

	// Block info
	let installedBlocks = $state<BlockManifest[]>([]);

	let activeRunId = $state<string | null>(null);

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
		stepSummary: { id: string; status: string; durationMs?: number }[];
	}
	let schedules = $state<Schedule[]>([]);
	let persistedHistory = $state<HistoryRecord[]>([]);


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
		try {
			const res = await fetch('/api/pipelines');
			if (res.ok) {
				const data = await res.json();
				pipelines = data.pipelines || [];
			}
		} catch { /* silent */ }
		loading = false;

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
		try {
			const res = await fetch(`/api/pipelines?name=${encodeURIComponent(name)}`);
			if (res.ok) {
				const data = await res.json();
				selected = { ...data.pipeline, config_files: data.config_files || [] };
				selectedPath = data.path || '';
				outputDir = data.outputDir || null;
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
				// Load output files
				if (outputDir) loadOutputFiles();
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
			}
		} catch { /* silent */ }
	}

	async function loadOutputFiles() {
		if (!outputDir) return;
		try {
			const res = await fetch(`/api/files?path=${encodeURIComponent(outputDir)}`);
			if (res.ok) {
				const data = await res.json();
				outputFiles = (data.entries || []).sort((a: any, b: any) => b.name.localeCompare(a.name));
			}
		} catch {
			outputFiles = [];
		}
	}

	function openOutput(fileName: string) {
		if (!outputDir) return;
		previewFile = { path: `${outputDir}/${fileName}`, name: fileName };
	}

	function back() {
		selected = null;
		selectedName = '';
		activeRun = null;
		activeRunId = null;
		running = false;
		expandedSteps = new Set();
		stepConfigEdits = {};
		outputDir = null;
		outputFiles = [];
		envStatus = [];
		selectedPath = '';
		previewFile = null;
		activeGates = new Map();
		promptAnswers = {};
		showFileContent = {};
		gateSubmitting = new Set();
		installedBlocks = [];
		selectedSchedule = null;
		webhookUrl = '';
		editingSchedule = false;
		scheduleInput = '';
		scheduleSaving = false;
		editingSecret = false;
		secretInput = '';
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
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
				(activeRun as any)._error = errorMsg;
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

					// Auto-expand running and waiting steps
					for (const e of statusData.events || []) {
						if (e.status === 'running' || e.status === 'waiting') expandedSteps.add(e.stepId);
					}
					expandedSteps = new Set(expandedSteps);

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
						// Refresh output files after run completes
						loadOutputFiles();
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

	function buildLocalCurl(): string {
		const base = `http://localhost:5173/api/pipelines/trigger?name=${selectedName}`;
		const secret = selectedSchedule?.triggerSecret ? `&token=${selectedSchedule.triggerSecret}` : '';
		return `curl "${base}${secret}"`;
	}

	function buildExternalCurl(): string {
		const url = buildTriggerUrl();
		const id = cfClientId || '$CF_ACCESS_CLIENT_ID';
		const secret = cfClientSecret || '$CF_ACCESS_CLIENT_SECRET';
		return `curl -H "CF-Access-Client-Id: ${id}" \\\n     -H "CF-Access-Client-Secret: ${secret}" \\\n     "${url}"`;
	}

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

</script>

<svelte:head>
	<title>Pipelines — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-6 py-4 border-b border-hub-border bg-hub-surface/50">
		<div class="max-w-4xl mx-auto flex items-center gap-3">
			<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to home">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>

			{#if selected}
				<button onclick={back} class="text-hub-muted hover:text-hub-text transition-colors cursor-pointer text-sm">Pipelines</button>
				<svg class="w-3 h-3 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				<h1 class="text-lg font-semibold text-hub-text">{selected.name}</h1>
				{#if selected.version}
					<span class="text-xs text-hub-dim font-mono">{selected.version}</span>
				{/if}
				<div class="flex-1"></div>
				<a
					href="/library/builder?pipeline={encodeURIComponent(selectedName)}"
					class="flex items-center gap-1.5 border border-hub-border text-hub-muted px-3 py-1.5 rounded-lg text-sm hover:text-hub-text hover:border-hub-dim transition-colors"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
					</svg>
					Edit in Builder
				</a>
			{:else}
				<h1 class="text-lg font-semibold text-hub-text">Pipelines</h1>
				<span class="text-sm text-hub-muted">{pipelines.length} available</span>
				<div class="flex-1"></div>
				<a
					href="/library/builder?type=pipeline"
					class="flex items-center gap-1.5 bg-hub-cta text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-hub-cta-hover transition-colors"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					New Pipeline
				</a>
			{/if}
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-6 py-6">
		<div class="max-w-4xl mx-auto">
			{#if loading}
				<div class="text-center py-20 text-hub-muted text-sm">Loading pipelines...</div>
			{:else if !selected}
				<!-- PIPELINE LIST -->
				{#if pipelines.length === 0}
					<div class="text-center py-20">
						<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
						<p class="text-hub-muted text-sm">No pipelines found</p>
						<p class="text-hub-dim text-xs mt-1">Add pipeline folders to ~/dev/soul-hub/pipelines/</p>
					</div>
				{:else}
					<section class="mb-8">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Available Pipelines</h2>
						<div class="space-y-3">
							{#each pipelines as pipeline}
								{@const pipelineSchedule = schedules.find((s) => s.name === pipeline.name)}
								<button
									onclick={() => selectPipeline(pipeline.name)}
									class="w-full text-left p-4 rounded-xl bg-hub-card border border-hub-border hover:border-hub-info/40 transition-all cursor-pointer group"
								>
									<div class="flex items-center gap-3 mb-1.5">
										<svg class="w-4 h-4 text-hub-info group-hover:text-hub-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
										<span class="font-semibold text-hub-text group-hover:text-hub-info transition-colors">{pipeline.name}</span>
										{#if pipelineSchedule?.schedule}
											<span class="px-1.5 py-0.5 rounded text-[9px] font-mono {pipelineSchedule.scheduleEnabled ? 'bg-hub-cta/10 text-hub-cta' : 'bg-hub-dim/10 text-hub-dim'}">
												{pipelineSchedule.schedule}
											</span>
										{/if}
									</div>
									<p class="text-sm text-hub-muted ml-7">{pipeline.description}</p>
								</button>
							{/each}
						</div>
					</section>
				{/if}

				<!-- RUN HISTORY -->
				{#if history.length > 0 || persistedHistory.length > 0}
					<section>
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Recent Runs</h2>
						<div class="space-y-2">
							{#each history as run}
								<div class="p-3 rounded-lg bg-hub-surface border border-hub-border/50">
									<div class="flex items-center gap-2 mb-1.5">
										<span class="text-sm {run.status === 'done' ? 'text-hub-cta' : 'text-hub-danger'}">
											{run.status === 'done' ? '✓' : '✗'}
										</span>
										<span class="text-sm font-medium text-hub-text">{run.pipelineName}</span>
										<span class="text-xs text-hub-dim ml-auto">{timeAgo(run.startedAt)}</span>
									</div>
									<div class="flex items-center gap-3 ml-5 text-xs text-hub-dim">
										{#each run.steps || [] as step}
											<span class="{statusColor[step.status]}">
												{statusIcon[step.status]} {step.id}
												{#if step.durationMs}({formatDuration(step.durationMs)}){/if}
											</span>
										{/each}
									</div>
								</div>
							{/each}
							{#each persistedHistory as record}
								<div class="p-3 rounded-lg bg-hub-surface border border-hub-border/50">
									<div class="flex items-center gap-2 mb-1.5">
										<span class="text-sm {record.status === 'done' ? 'text-hub-cta' : 'text-hub-danger'}">
											{record.status === 'done' ? '✓' : '✗'}
										</span>
										<span class="text-sm font-medium text-hub-text">{record.pipelineName}</span>
										<span class="px-1.5 py-0.5 rounded text-[9px] font-medium
											{record.trigger === 'scheduled' ? 'bg-hub-purple/10 text-hub-purple' :
											 record.trigger === 'webhook' ? 'bg-hub-info/10 text-hub-info' :
											 'bg-hub-dim/10 text-hub-dim'}">
											{record.trigger}
										</span>
										<span class="text-xs text-hub-dim ml-auto">{timeAgo(record.startedAt)}</span>
									</div>
									<div class="flex items-center gap-3 ml-5 text-xs text-hub-dim">
										{#each record.stepSummary || [] as step}
											<span class="{statusColor[step.status]}">
												{statusIcon[step.status]} {step.id}
												{#if step.durationMs}({formatDuration(step.durationMs)}){/if}
											</span>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					</section>
				{/if}

			{:else}
				<!-- PIPELINE DETAIL + RUN -->
				<p class="text-sm text-hub-muted mb-6">{selected.description}</p>

				<!-- Automation: Schedule + Trigger -->
				{#if selectedSchedule}
					<section class="mb-6">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Automation</h2>
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
										<!-- Test curl — local -->
										<div class="flex items-start gap-2 pt-1.5 border-t border-hub-border/30">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Local</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{buildLocalCurl()}</pre>
											<button onclick={() => navigator.clipboard.writeText(buildLocalCurl())}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
										<!-- Test curl — external (via Cloudflare Access) -->
										<div class="flex items-start gap-2">
											<span class="text-[10px] text-hub-dim w-12 pt-0.5 flex-shrink-0">Remote</span>
											<pre class="text-[10px] font-mono text-hub-muted bg-hub-bg px-2 py-1 rounded flex-1 select-all whitespace-pre-wrap">{buildExternalCurl()}</pre>
											<button onclick={() => navigator.clipboard.writeText(buildExternalCurl())}
												class="text-[10px] text-hub-info hover:text-hub-info/80 cursor-pointer pt-0.5">Copy</button>
										</div>
									</div>
								{/if}
							</div>
						</div>
					</section>
				{/if}

				<!-- Env var banner -->
				{#if missingEnvVars.length > 0}
					<section class="mb-6" role="alert">
						<div class="bg-hub-warning/5 border border-hub-warning/30 rounded-lg p-4">
							<div class="flex items-center gap-2 mb-2">
								<span class="text-hub-warning text-sm">!</span>
								<h3 class="text-xs font-medium text-hub-warning">Missing environment variables</h3>
							</div>
							<div class="space-y-1 mb-3">
								{#each missingEnvVars as env}
									<div class="flex items-center gap-2 text-xs">
										<span class="font-mono text-hub-text">{env.name}</span>
										{#if env.description}
											<span class="text-hub-dim">— {env.description}</span>
										{/if}
									</div>
								{/each}
							</div>
							<a href="/settings" class="text-[11px] text-hub-info hover:underline cursor-pointer">
								Configure in Settings → Platform Environment
							</a>
						</div>
					</section>
				{/if}

				<!-- Shared Config -->
				{#if selected.config_files && selected.config_files.length > 0}
					<section class="mb-6">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Shared Config</h2>
						<div class="space-y-3">
							{#each selected.config_files as cfg}
								<SharedConfigEditor
									pipelineName={selectedName}
									configFile={{ name: cfg.name, file: cfg.path, description: cfg.description, columns: cfg.columns }}
								/>
							{/each}
						</div>
					</section>
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

					<div class="space-y-2">
						{#each selected.steps as step}
							{@const status = activeRun ? getStepStatus(step.id) : 'pending'}
							{@const duration = getStepDuration(step.id)}
							{@const output = getStepOutput(step.id)}
							{@const isExpanded = expandedSteps.has(step.id)}
							{@const block = getBlockForStep(step)}
							{@const blockEnv = block ? getBlockEnvStatus(block) : []}

							<!-- Block-backed steps use StepConfigCard -->
							{#if step.block}
								<div class="rounded-lg border overflow-hidden transition-colors
									{status === 'running' ? 'border-hub-info/40 bg-hub-info/5' :
									 status === 'waiting' ? 'border-hub-warning/40 bg-hub-warning/5' :
									 status === 'done' ? 'border-hub-cta/20 bg-hub-surface' :
									 status === 'failed' ? 'border-hub-danger/30 bg-hub-danger/5' :
									 'border-hub-border/50 bg-hub-surface'}">

									<!-- Runtime status indicator + StepConfigCard -->
									{#if activeRun}
										<div class="flex items-center gap-2 px-4 pt-3 pb-0">
											<span class="text-base {statusColor[status]} {status === 'running' ? 'animate-pulse' : ''}">
												{statusIcon[status]}
											</span>
											{#if duration}
												<span class="text-xs text-hub-dim">{duration}</span>
											{/if}
											{#if status === 'skipped' && getSkipReason(step.id)}
												<span class="text-[9px] text-hub-dim italic">({getSkipReason(step.id)})</span>
											{/if}
										</div>
									{/if}

									<StepConfigCard
										{step}
										{block}
										configValues={stepConfigEdits[step.id] || {}}
										envStatus={blockEnv}
										expanded={isExpanded}
										ontoggle={toggleStep}
										onconfigchange={handleStepConfigChange}
									/>

									<!-- Runtime: gate UI or terminal output (appended below config) -->
									{#if isExpanded}
										{@const gate = activeGates.get(step.id)}
										{@const isSubmitting = gateSubmitting.has(step.id)}

										{#if gate && status === 'waiting'}
											{#if gate.type === 'approval'}
												<div class="border-t border-hub-warning/30 bg-hub-warning/5 px-4 py-4">
													<p class="text-sm text-hub-text mb-3">{gate.message || 'Review and approve to continue'}</p>
													{#if showFileContent[step.id]}
														<div class="mb-4 rounded-lg border border-hub-border/50 overflow-hidden">
															<div class="px-3 py-1.5 bg-hub-surface text-[10px] text-hub-dim font-mono border-b border-hub-border/30">{gate.show}</div>
															<pre class="px-4 py-3 text-xs font-mono text-hub-muted leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap bg-[#0a0a0f]">{showFileContent[step.id]}</pre>
														</div>
													{/if}
													<div class="flex items-center gap-3">
														<button onclick={() => handleApprove(step.id)} disabled={isSubmitting}
															class="px-4 py-2 rounded-lg text-sm font-medium bg-hub-cta text-white hover:bg-hub-cta/80 transition-colors cursor-pointer disabled:opacity-50">
															{isSubmitting ? 'Approving...' : 'Approve'}
														</button>
														<button onclick={() => handleReject(step.id)} disabled={isSubmitting}
															class="px-4 py-2 rounded-lg text-sm font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 transition-colors cursor-pointer disabled:opacity-50">
															Reject
														</button>
													</div>
												</div>
											{:else if gate.type === 'prompt'}
												<div class="border-t border-hub-info/30 bg-hub-info/5 px-4 py-4">
													<p class="text-sm text-hub-text mb-3">{gate.question || 'Provide input to continue'}</p>
													{#if gate.options && gate.options.length > 0}
														<div class="space-y-2 mb-4">
															{#each gate.options as opt}
																<label class="flex items-center gap-2 cursor-pointer text-sm text-hub-muted hover:text-hub-text transition-colors">
																	<input type="radio" name="prompt-{step.id}" value={opt} checked={promptAnswers[step.id] === opt} onchange={() => { promptAnswers[step.id] = opt; }} class="accent-hub-info" />
																	{opt}
																</label>
															{/each}
														</div>
													{:else}
														<input type="text" bind:value={promptAnswers[step.id]} placeholder="Type your answer..."
															onkeydown={(e) => { if (e.key === 'Enter') handleAnswer(step.id); }}
															class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-2 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 mb-3" />
													{/if}
													<button onclick={() => handleAnswer(step.id)} disabled={isSubmitting || !promptAnswers[step.id]}
														class="px-4 py-2 rounded-lg text-sm font-medium bg-hub-info text-white hover:bg-hub-info/80 transition-colors cursor-pointer disabled:opacity-50">
														{isSubmitting ? 'Submitting...' : 'Submit'}
													</button>
												</div>
											{/if}
										{:else if output && !output.includes('"_gate":true')}
											<div class="border-t border-hub-border/30">
												<pre class="px-4 py-3 text-xs font-mono text-hub-muted leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap break-all bg-[#0a0a0f]">{output}</pre>
											</div>
										{/if}
									{/if}
								</div>

							<!-- Non-block steps: approval, prompt, channel, legacy script/agent -->
							{:else}
								<div class="rounded-lg border overflow-hidden transition-colors
									{status === 'running' ? 'border-hub-info/40 bg-hub-info/5' :
									 status === 'waiting' ? 'border-hub-warning/40 bg-hub-warning/5' :
									 status === 'done' ? 'border-hub-cta/20 bg-hub-surface' :
									 status === 'failed' ? 'border-hub-danger/30 bg-hub-danger/5' :
									 'border-hub-border/50 bg-hub-surface'}">

									<button
										onclick={() => toggleStep(step.id)}
										class="w-full flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-hub-bg/30 transition-colors"
									>
										<span class="text-base {statusColor[status]} {status === 'running' ? 'animate-pulse' : ''}">
											{statusIcon[status]}
										</span>
										<div class="flex-1 text-left">
											<div class="flex items-center gap-2 flex-wrap">
												<span class="text-sm font-mono font-medium text-hub-text">{step.id}</span>
												<span class="px-1.5 py-0.5 rounded text-[9px] font-medium
													{step.type === 'agent' ? 'bg-hub-purple/10 text-hub-purple' :
													 step.type === 'approval' ? 'bg-hub-warning/10 text-hub-warning' :
													 step.type === 'prompt' ? 'bg-hub-info/10 text-hub-info' :
													 'bg-hub-info/10 text-hub-info'}">
													{step.type}
												</span>
												{#if duration}
													<span class="text-xs text-hub-dim">{duration}</span>
												{/if}
												{#if status === 'skipped' && getSkipReason(step.id)}
													<span class="text-[9px] text-hub-dim italic">({getSkipReason(step.id)})</span>
												{/if}
											</div>
											<p class="text-[11px] text-hub-dim mt-0.5">
												{#if step.type === 'approval'}
													approval gate
												{:else if step.type === 'prompt'}
													user prompt
												{:else}
													{step.type === 'script' ? step.run : step.agent}
												{/if}
												{#if step.when}
													<span class="text-hub-info/50"> when {step.when}</span>
												{:else if step.skip_if}
													<span class="text-hub-warning/50"> skip if {step.skip_if}</span>
												{/if}
												{#if step.depends_on?.length}
													<span class="text-hub-dim/50"> after {step.depends_on.join(', ')}</span>
												{/if}
											</p>
										</div>
										<svg class="w-3.5 h-3.5 text-hub-dim transition-transform {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
									</button>

									{#if isExpanded}
										{@const gate = activeGates.get(step.id)}
										{@const isSubmitting = gateSubmitting.has(step.id)}

										{#if gate && status === 'waiting'}
											{#if gate.type === 'approval'}
												<div class="border-t border-hub-warning/30 bg-hub-warning/5 px-4 py-4">
													<p class="text-sm text-hub-text mb-3">{gate.message || 'Review and approve to continue'}</p>
													{#if showFileContent[step.id]}
														<div class="mb-4 rounded-lg border border-hub-border/50 overflow-hidden">
															<div class="px-3 py-1.5 bg-hub-surface text-[10px] text-hub-dim font-mono border-b border-hub-border/30">{gate.show}</div>
															<pre class="px-4 py-3 text-xs font-mono text-hub-muted leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap bg-[#0a0a0f]">{showFileContent[step.id]}</pre>
														</div>
													{/if}
													<div class="flex items-center gap-3">
														<button onclick={() => handleApprove(step.id)} disabled={isSubmitting}
															class="px-4 py-2 rounded-lg text-sm font-medium bg-hub-cta text-white hover:bg-hub-cta/80 transition-colors cursor-pointer disabled:opacity-50">
															{isSubmitting ? 'Approving...' : 'Approve'}
														</button>
														<button onclick={() => handleReject(step.id)} disabled={isSubmitting}
															class="px-4 py-2 rounded-lg text-sm font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 transition-colors cursor-pointer disabled:opacity-50">
															Reject
														</button>
													</div>
												</div>
											{:else if gate.type === 'prompt'}
												<div class="border-t border-hub-info/30 bg-hub-info/5 px-4 py-4">
													<p class="text-sm text-hub-text mb-3">{gate.question || 'Provide input to continue'}</p>
													{#if gate.options && gate.options.length > 0}
														<div class="space-y-2 mb-4">
															{#each gate.options as opt}
																<label class="flex items-center gap-2 cursor-pointer text-sm text-hub-muted hover:text-hub-text transition-colors">
																	<input type="radio" name="prompt-{step.id}" value={opt} checked={promptAnswers[step.id] === opt} onchange={() => { promptAnswers[step.id] = opt; }} class="accent-hub-info" />
																	{opt}
																</label>
															{/each}
														</div>
													{:else}
														<input type="text" bind:value={promptAnswers[step.id]} placeholder="Type your answer..."
															onkeydown={(e) => { if (e.key === 'Enter') handleAnswer(step.id); }}
															class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-2 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 mb-3" />
													{/if}
													<button onclick={() => handleAnswer(step.id)} disabled={isSubmitting || !promptAnswers[step.id]}
														class="px-4 py-2 rounded-lg text-sm font-medium bg-hub-info text-white hover:bg-hub-info/80 transition-colors cursor-pointer disabled:opacity-50">
														{isSubmitting ? 'Submitting...' : 'Submit'}
													</button>
												</div>
											{/if}
										{:else if output && !output.includes('"_gate":true')}
											<div class="border-t border-hub-border/30">
												<pre class="px-4 py-3 text-xs font-mono text-hub-muted leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap break-all bg-[#0a0a0f]">{output}</pre>
											</div>
										{/if}
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				</section>

				<!-- Run button -->
				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-3">
					<button
						onclick={runPipeline}
						disabled={running || !canRun}
						class="px-6 py-2.5 rounded-lg text-sm font-medium transition-colors
							{running ? 'bg-hub-info/20 text-hub-info cursor-wait' : !canRun ? 'bg-hub-dim/20 text-hub-dim cursor-not-allowed' : 'bg-hub-info text-white hover:bg-hub-info/80 cursor-pointer'}"
					>
						{#if running}
							<span class="inline-flex items-center gap-2">
								<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
								</svg>
								Running...
							</span>
						{:else}
							<span class="inline-flex items-center gap-2">
								<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
								Run Pipeline
							</span>
						{/if}
					</button>

					{#if running}
						<button
							onclick={killRun}
							class="px-4 py-2.5 rounded-lg text-sm font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 transition-colors cursor-pointer"
						>
							Stop
						</button>
					{/if}

					{#if activeRun && !running}
						{@const outputPath = getLastOutputPath()}
						<div class="flex items-center gap-2 text-sm
							{activeRun.status === 'done' ? 'text-hub-cta' : 'text-hub-danger'}">
							<span>{activeRun.status === 'done' ? '✓ Pipeline completed' : '✗ Pipeline failed'}</span>
							{#if activeRun.finishedAt && activeRun.startedAt}
								<span class="text-hub-dim">
									{formatDuration(new Date(activeRun.finishedAt).getTime() - new Date(activeRun.startedAt).getTime())}
								</span>
							{/if}
						</div>
						{#if (activeRun as any)._error}
							<pre class="text-xs text-hub-danger bg-hub-danger/5 border border-hub-danger/20 rounded-md px-3 py-2 mt-2 whitespace-pre-wrap">{(activeRun as any)._error}</pre>
						{/if}
					{/if}
					</div>
					{#if !canRun && !running}
						<p class="text-[11px] text-hub-dim">
							{#if missingEnvVars.length > 0}{missingEnvVars.length} env var{missingEnvVars.length > 1 ? 's' : ''} missing{/if}{#if missingEnvVars.length > 0 && missingInputs.length > 0}, {/if}{#if missingInputs.length > 0}{missingInputs.length} required input{missingInputs.length > 1 ? 's' : ''} empty{/if}
						</p>
					{/if}
				</div>

				<!-- Output Library -->
				{#if outputDir && outputFiles.length > 0}
					<section class="mt-8">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Output Library</h2>
						<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden">
							<div class="px-4 py-2 border-b border-hub-border/50 flex items-center gap-2">
								<svg class="w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
								<span class="text-xs text-hub-dim font-mono truncate">{outputDir}</span>
							</div>
							<div class="divide-y divide-hub-border/30">
								{#each outputFiles as file}
									<button
										onclick={() => openOutput(file.name)}
										class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-hub-bg/30 transition-colors cursor-pointer text-left"
									>
										<svg class="w-3.5 h-3.5 flex-shrink-0 {file.type === 'dir' ? 'text-hub-info' : 'text-hub-muted'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											{#if file.type === 'dir'}
												<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
											{:else}
												<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
											{/if}
										</svg>
										<span class="text-sm text-hub-text flex-1 truncate">{file.name}</span>
										{#if file.size}
											<span class="text-[10px] text-hub-dim">{file.size < 1024 ? `${file.size}B` : `${(file.size / 1024).toFixed(1)}KB`}</span>
										{/if}
									</button>
								{/each}
							</div>
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
