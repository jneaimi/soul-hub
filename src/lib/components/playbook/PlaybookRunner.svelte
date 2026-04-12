<script lang="ts">
	import { onDestroy } from 'svelte';
	import PlaybookPhases from './PlaybookPhases.svelte';
	import PlaybookResult from './PlaybookResult.svelte';

	let {
		playbookName,
		inputValues = {},
		disabled = false,
		configPhases = [],
		specInputs = [],
		isRunning = $bindable(false),
		runElapsed = $bindable(''),
		runStatus = $bindable(''),
		onStart,
		onKill,
	} = $props<{
		playbookName: string;
		inputValues: Record<string, string | number>;
		disabled: boolean;
		configPhases: { id: string; type: string }[];
		specInputs: { id: string; required?: boolean }[];
		isRunning?: boolean;
		runElapsed?: string;
		runStatus?: string;
		onStart?: () => void;
		onKill?: () => void;
	}>();

	// Sync to parent via $effect
	import { tick } from 'svelte';
	$effect(() => { isRunning = running; });
	$effect(() => { runElapsed = elapsed; });
	$effect(() => { runStatus = status; });

	// Run state
	let running = $state(false);
	let runId = $state('');
	type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

	interface PhaseRunState {
		id: string;
		type: string;
		status: PhaseStatus;
		assignments: { role: string; status: string; error?: string }[];
		depends_on?: string[];
		error?: string;
		iterations?: number;
	}

	let phases = $state<PhaseRunState[]>([]);
	let events = $state<any[]>([]);
	let taskOutput = $state<Record<string, string>>({});
	let status = $state('');
	let error = $state('');
	let elapsed = $state('');
	let startTime = $state(0);
	let runResult = $state<{ status: string; phases: any[] } | null>(null);
	let outputFiles = $state<Record<string, string>>({});
	let activeReportTab = $state('');

	// Gate / Human
	let waitingForGate = $state('');
	let gatePrompt = $state('');
	let waitingForHuman = $state('');
	let humanPrompt = $state('');
	let humanResponse = $state('');
	let rejectReason = $state('');
	let showRejectInput = $state(false);

	// Timers
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let elapsedInterval: ReturnType<typeof setInterval> | null = null;

	function canRun(): boolean {
		if (running || disabled) return false;
		for (const inp of specInputs) {
			if (inp.required && !inputValues[inp.id]) return false;
		}
		return true;
	}

	function formatDuration(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m ${rs}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	function stopTimers() {
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
		if (elapsedInterval) {
			clearInterval(elapsedInterval);
			elapsedInterval = null;
			if (startTime) elapsed = formatDuration(Date.now() - startTime);
		}
	}

	/** Call from parent to start the run */
	export function start() { startRun(); }
	/** Call from parent to kill the run */
	export function stop() { kill(); }

	async function startRun() {
		running = true;
		runResult = null;
		error = '';
		taskOutput = {};
		status = 'starting';
		waitingForGate = '';
		waitingForHuman = '';
		showRejectInput = false;

		// Init phase states from config
		phases = configPhases.map((ph: { id: string; type: string }) => ({
			id: ph.id,
			type: ph.type,
			status: 'pending',
			assignments: [],
		}));

		// Start elapsed timer
		startTime = Date.now();
		elapsedInterval = setInterval(() => {
			elapsed = formatDuration(Date.now() - startTime);
		}, 1000);

		try {
			const res = await fetch('/api/playbooks/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ playbook: playbookName, inputs: inputValues }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				error = err.error || 'Failed to start';
				running = false;
				stopTimers();
				return;
			}

			const data = await res.json();
			runId = data.runId;
			status = 'running';

			// Start polling
			pollInterval = setInterval(poll, 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to start';
			running = false;
			stopTimers();
		}
	}

	async function poll() {
		if (!runId) return;
		try {
			const res = await fetch(`/api/playbooks/run?id=${runId}`);
			if (!res.ok) return;
			const data = await res.json();

			// Sync state
			if (data.phases) {
				phases = data.phases.map((p: any) => ({
					id: p.id,
					type: p.type,
					status: p.status as PhaseStatus,
					assignments: (p.assignments || []).map((a: any) => ({
						role: a.role,
						status: a.status,
						error: a.error,
					})),
					depends_on: p.depends_on,
					error: p.error,
					iterations: p.iterations,
				}));
			}
			if (data.events) events = data.events;
			if (data.taskOutput) taskOutput = data.taskOutput;
			if (data.status) status = data.status;

			// Detect gate/human from events
			for (const ev of data.events || []) {
				if (ev.status === 'gate_required' && !waitingForGate) {
					waitingForGate = ev.phaseId;
					gatePrompt = ev.detail || 'Approve this phase?';
				}
				if (ev.status === 'human_required' && !waitingForHuman) {
					waitingForHuman = ev.phaseId;
					humanPrompt = ev.detail || 'Input required';
				}
			}

			// Check completion
			if (data.status === 'completed' || data.status === 'failed') {
				runResult = { status: data.status, phases: data.phases };
				if (data.outputFiles) {
					outputFiles = data.outputFiles;
					const keys = Object.keys(data.outputFiles);
					if (keys.length > 0 && !activeReportTab) activeReportTab = keys[0];
				}
				if (data.status === 'failed') {
					const failedPhase = data.phases?.find((p: any) => p.status === 'failed');
					if (failedPhase?.error) error = failedPhase.error;
				}
				running = false;
				stopTimers();
			}
		} catch { /* retry next poll */ }
	}

	async function approveGate() {
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'approve', runId, phaseId: waitingForGate }),
		});
		waitingForGate = '';
		gatePrompt = '';
	}

	async function rejectGate() {
		if (!showRejectInput) {
			showRejectInput = true;
			return;
		}
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'reject',
				runId,
				phaseId: waitingForGate,
				reason: rejectReason || 'Rejected',
			}),
		});
		waitingForGate = '';
		gatePrompt = '';
		rejectReason = '';
		showRejectInput = false;
	}

	async function submitHuman() {
		if (!humanResponse.trim()) return;
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'human_input',
				runId,
				phaseId: waitingForHuman,
				value: humanResponse,
			}),
		});
		waitingForHuman = '';
		humanPrompt = '';
		humanResponse = '';
	}

	async function kill() {
		if (!runId) return;
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'kill', runId }),
		});
	}

	function reset() {
		runId = '';
		runResult = null;
		phases = [];
		events = [];
		taskOutput = {};
		outputFiles = {};
		activeReportTab = '';
		status = '';
		error = '';
		elapsed = '';
		waitingForGate = '';
		waitingForHuman = '';
		showRejectInput = false;
	}

	onDestroy(stopTimers);
</script>

<!-- Run Error -->
{#if error && !running}
	<div class="border border-hub-danger/30 bg-hub-danger/5 rounded-lg p-4 text-sm text-hub-danger">
		{error}
	</div>
{/if}

<!-- Phase Progress (only during run) -->
{#if phases.length > 0 && running}
	<PlaybookPhases {phases} />
{/if}

<!-- Gate Required -->
{#if waitingForGate}
	<div class="border-2 border-hub-warning/40 bg-hub-warning/5 rounded-lg p-4">
		<p class="text-sm text-hub-warning font-medium mb-3">Gate: {gatePrompt}</p>
		{#if showRejectInput}
			<div class="mb-3">
				<input
					type="text"
					bind:value={rejectReason}
					placeholder="Rejection reason..."
					class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-danger/50"
				/>
			</div>
		{/if}
		<div class="flex gap-2">
			<button
				onclick={approveGate}
				class="px-4 py-1.5 bg-hub-cta text-black rounded-lg text-sm font-medium hover:bg-hub-cta-hover transition-colors duration-200 cursor-pointer"
			>
				Approve
			</button>
			<button
				onclick={rejectGate}
				class="px-4 py-1.5 bg-hub-danger text-white rounded-lg text-sm font-medium hover:bg-hub-danger/80 transition-colors duration-200 cursor-pointer"
			>
				{showRejectInput ? 'Confirm Reject' : 'Reject'}
			</button>
		</div>
	</div>
{/if}

<!-- Human Input Required -->
{#if waitingForHuman}
	<div class="border-2 border-hub-info/40 bg-hub-info/5 rounded-lg p-4">
		<p class="text-sm text-hub-info font-medium mb-3">{humanPrompt}</p>
		<textarea
			bind:value={humanResponse}
			rows="4"
			class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50 resize-y"
			placeholder="Your response..."
		></textarea>
		<button
			onclick={submitHuman}
			disabled={!humanResponse.trim()}
			class="mt-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors duration-200
				{humanResponse.trim()
					? 'bg-hub-cta text-black hover:bg-hub-cta-hover cursor-pointer'
					: 'bg-hub-border text-hub-dim cursor-not-allowed'}"
		>
			Submit
		</button>
	</div>
{/if}

<!-- Result (only after completion — includes phases, output, and summary) -->
{#if runResult && !running}
	<PlaybookResult
		status={runResult.status}
		phases={runResult.phases}
		{elapsed}
		{error}
	/>

	<!-- Report Files (shown after completion) -->
	{#if Object.keys(outputFiles).length > 0}
		{@const fileEntries = Object.entries(outputFiles)}
		<section>
			<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Reports</h2>
			<div class="border border-hub-border rounded-lg overflow-hidden">
				<!-- Tab bar -->
				<div class="flex border-b border-hub-border bg-hub-panel/30 overflow-x-auto">
					{#each fileEntries as [path]}
						{@const label = path.replace(/\.md$/, '').split('/').pop() || path}
						<button
							onclick={() => activeReportTab = path}
							class="px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors duration-150 cursor-pointer
								{activeReportTab === path
									? 'border-hub-cta text-hub-cta'
									: 'border-transparent text-hub-dim hover:text-hub-muted'}"
						>
							{label}
						</button>
					{/each}
				</div>
				<!-- Content -->
				<div class="p-4 max-h-[500px] overflow-y-auto">
					{#each fileEntries as [path, content]}
						{#if activeReportTab === path}
							<pre class="text-xs text-hub-muted whitespace-pre-wrap font-mono leading-relaxed">{content}</pre>
						{/if}
					{/each}
				</div>
			</div>
		</section>
	{/if}

	<!-- Actions -->
	<div class="flex gap-2">
		{#if runResult?.status === 'failed'}
			<a
				href="/playbooks/builder?playbook={encodeURIComponent(playbookName)}&troubleshoot={encodeURIComponent(runId)}&error={encodeURIComponent(error || 'Run failed')}"
				class="flex-1 py-2.5 rounded-lg text-sm font-medium text-center bg-hub-danger/10 text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/20 transition-colors duration-200 cursor-pointer"
			>
				Troubleshoot
			</a>
		{/if}
		<button
			onclick={reset}
			class="flex-1 py-2.5 rounded-lg text-sm font-medium bg-hub-panel text-hub-text border border-hub-border hover:border-hub-dim transition-colors duration-200 cursor-pointer"
		>
			Run Again
		</button>
	</div>
{/if}
