<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';

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
		inputs?: { name: string; type: string; description: string; default?: string | number; options?: string[] }[];
		steps: { id: string; type: string; agent?: string; run?: string; depends_on?: string[] }[];
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
	let inputValues = $state<Record<string, string | number>>({});

	// Run state
	let activeRun = $state<RunResult | null>(null);
	let running = $state(false);
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// Step card expansion
	let expandedSteps = $state<Set<string>>(new Set());

	// Run history
	let history = $state<RunResult[]>([]);

	// Output browser
	let outputDir = $state<string | null>(null);
	let outputFiles = $state<{ name: string; type: string; size?: number }[]>([]);
	let previewFile = $state<{ path: string; name: string } | null>(null);

	let activeRunId = $state<string | null>(null);

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

		// Load run history
		try {
			const res = await fetch('/api/pipelines/run');
			if (res.ok) {
				const data = await res.json();
				history = (data.runs || []).filter((r: RunResult) => r.status === 'done' || r.status === 'failed');
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
				selected = data.pipeline;
				outputDir = data.outputDir || null;
				inputValues = {};
				for (const input of data.pipeline.inputs || []) {
					if (input.default !== undefined) inputValues[input.name] = input.default;
				}
				// Load output files
				if (outputDir) loadOutputFiles();
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
		outputDir = null;
		outputFiles = [];
		previewFile = null;
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
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
				body: JSON.stringify({ name: selectedName, inputs: inputValues }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				running = false;
				// Show concurrency error
				if (res.status === 409) {
					activeRun = { runId: '', pipelineName: selectedName, status: 'failed', startedAt: new Date().toISOString(), steps: [], events: [], stepOutput: {}, finishedAt: new Date().toISOString() } as RunResult;
					(activeRun as any)._error = err.error || 'Pipeline is already running';
				}
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

					// Auto-expand running step
					for (const e of statusData.events || []) {
						if (e.status === 'running') expandedSteps.add(e.stepId);
					}
					expandedSteps = new Set(expandedSteps);

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
			{:else}
				<h1 class="text-lg font-semibold text-hub-text">Pipelines</h1>
				<span class="text-sm text-hub-muted">{pipelines.length} available</span>
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
								<button
									onclick={() => selectPipeline(pipeline.name)}
									class="w-full text-left p-4 rounded-xl bg-hub-card border border-hub-border hover:border-hub-info/40 transition-all cursor-pointer group"
								>
									<div class="flex items-center gap-3 mb-1.5">
										<svg class="w-4 h-4 text-hub-info group-hover:text-hub-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
										<span class="font-semibold text-hub-text group-hover:text-hub-info transition-colors">{pipeline.name}</span>
									</div>
									<p class="text-sm text-hub-muted ml-7">{pipeline.description}</p>
								</button>
							{/each}
						</div>
					</section>
				{/if}

				<!-- RUN HISTORY -->
				{#if history.length > 0}
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
						</div>
					</section>
				{/if}

			{:else}
				<!-- PIPELINE DETAIL + RUN -->
				<p class="text-sm text-hub-muted mb-6">{selected.description}</p>

				<!-- Inputs form -->
				{#if selected.inputs && selected.inputs.length > 0}
					<section class="mb-6">
						<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Configuration</h2>
						<div class="bg-hub-surface border border-hub-border rounded-lg p-4 space-y-3">
							{#each selected.inputs as input}
								<div>
									<label for="input-{input.name}" class="block text-xs text-hub-muted mb-1">{input.description}</label>
									{#if input.type === 'select' && input.options}
										<select
											id="input-{input.name}"
											bind:value={inputValues[input.name]}
											class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50 cursor-pointer"
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
											class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-info/50"
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

							<div class="rounded-lg border overflow-hidden transition-colors
								{status === 'running' ? 'border-hub-info/40 bg-hub-info/5' :
								 status === 'done' ? 'border-hub-cta/20 bg-hub-surface' :
								 status === 'failed' ? 'border-hub-danger/30 bg-hub-danger/5' :
								 'border-hub-border/50 bg-hub-surface'}">

								<!-- Step header (clickable) -->
								<button
									onclick={() => toggleStep(step.id)}
									class="w-full flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-hub-bg/30 transition-colors"
								>
									<span class="text-base {statusColor[status]} {status === 'running' ? 'animate-pulse' : ''}">
										{statusIcon[status]}
									</span>
									<div class="flex-1 text-left">
										<div class="flex items-center gap-2">
											<span class="text-sm font-mono font-medium text-hub-text">{step.id}</span>
											<span class="px-1.5 py-0.5 rounded text-[9px] font-medium
												{step.type === 'agent' ? 'bg-hub-purple/10 text-hub-purple' : 'bg-hub-info/10 text-hub-info'}">
												{step.type}
											</span>
											{#if duration}
												<span class="text-xs text-hub-dim">{duration}</span>
											{/if}
										</div>
										<p class="text-[11px] text-hub-dim mt-0.5">
											{step.type === 'script' ? step.run : step.agent}
											{#if step.depends_on?.length}
												<span class="text-hub-dim/50"> after {step.depends_on.join(', ')}</span>
											{/if}
										</p>
									</div>
									<svg class="w-3.5 h-3.5 text-hub-dim transition-transform {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
								</button>

								<!-- Expanded terminal output -->
								{#if isExpanded && output}
									<div class="border-t border-hub-border/30">
										<pre class="px-4 py-3 text-xs font-mono text-hub-muted leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap break-all bg-[#0a0a0f]">{output}</pre>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>

				<!-- Run button -->
				<div class="flex items-center gap-3">
					<button
						onclick={runPipeline}
						disabled={running}
						class="px-6 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
							{running ? 'bg-hub-info/20 text-hub-info' : 'bg-hub-info text-white hover:bg-hub-info/80'}"
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
