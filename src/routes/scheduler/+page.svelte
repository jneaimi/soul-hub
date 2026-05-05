<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import StatusPill from '$lib/components/scheduler/StatusPill.svelte';
	import CronExpression from '$lib/components/scheduler/CronExpression.svelte';
	import RunHistoryRow from '$lib/components/scheduler/RunHistoryRow.svelte';
	import type { RunRow } from '$lib/components/scheduler/RunHistoryRow.svelte';

	interface Task {
		id: string;
		type: string;
		cron: string;
		timezone: string | null;
		enabled: boolean;
		noOverlap: boolean;
		description: string | null;
		params: Record<string, unknown>;
		nextRunAt: string | null;
		lastRunAt: string | null;
		lastStatus: string | null;
		recentHistory: RunRow[];
	}

	type FilterMode = 'all' | 'active' | 'failed' | 'ai-suggested';

	let tasks = $state<Task[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<FilterMode>('all');
	let search = $state('');
	let expandedIds = $state(new Set<string>());
	let runningIds = $state(new Set<string>());
	let runNowConfirm = $state(new Map<string, number>());
	let toast = $state<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	async function loadTasks() {
		try {
			const res = await fetch('/api/scheduler/tasks?historyLimit=10');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			tasks = data.tasks ?? [];
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	const filteredTasks = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return tasks.filter((t) => {
			if (q && !t.id.toLowerCase().includes(q)) return false;
			if (filter === 'active' && !t.enabled) return false;
			if (filter === 'failed' && t.lastStatus !== 'error') return false;
			if (filter === 'ai-suggested') {
				const aiSuggested = isAiSuggested(t);
				if (!aiSuggested) return false;
			}
			return true;
		});
	});

	function isAiSuggested(t: Task): boolean {
		// Heuristic: vault-scout is the only AI-driven producer right now,
		// and any future heartbeat-suggested task will set
		// `params.suggestedBy: 'heartbeat'` per ADR-004.
		if (t.type === 'vault-scout' || t.type === 'daily-focus') return true;
		const sb = t.params?.suggestedBy;
		return typeof sb === 'string' && sb.length > 0;
	}

	function pillState(t: Task): 'success' | 'failed' | 'running' | 'scheduled' | 'disabled' | 'missed' {
		if (!t.enabled) return 'disabled';
		if (runningIds.has(t.id)) return 'running';
		if (t.lastStatus === 'error') return 'failed';
		if (t.lastStatus === 'success') return 'success';
		return 'scheduled';
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		const future = ms < 0;
		const abs = Math.abs(ms);
		const secs = Math.floor(abs / 1000);
		const mins = Math.floor(secs / 60);
		const hours = Math.floor(mins / 60);
		const days = Math.floor(hours / 24);
		const fmt =
			days > 0 ? `${days}d ${hours % 24}h`
			: hours > 0 ? `${hours}h ${mins % 60}m`
			: mins > 0 ? `${mins}m`
			: `${secs}s`;
		return future ? `in ${fmt}` : `${fmt} ago`;
	}

	function absoluteTime(iso: string | null, tz: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleString('en-GB', {
				timeZone: tz ?? undefined,
				weekday: 'short',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			});
		} catch {
			return new Date(iso).toLocaleString();
		}
	}

	function durationOf(t: Task): string {
		const r = t.recentHistory[0];
		if (!r || r.durationMs === null) return '';
		if (r.durationMs < 1000) return `${r.durationMs}ms`;
		if (r.durationMs < 60_000) return `${(r.durationMs / 1000).toFixed(1)}s`;
		return `${(r.durationMs / 60_000).toFixed(1)}m`;
	}

	function lastErrorExcerpt(t: Task): string {
		const r = t.recentHistory[0];
		if (!r?.errorMessage) return '';
		return r.errorMessage.slice(0, 80);
	}

	function isEditable(t: Task): boolean {
		return t.type === 'shell-script' || t.type === 'trigger-pipeline';
	}

	function toggleExpand(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	async function runNow(t: Task) {
		// Click-again-to-cancel UX: a running task's button morphs into
		// "Cancel" and a second click POSTs /api/scheduler/cancel. Confirm
		// state expires after 5s so an accidental second click on a
		// long-finished task doesn't trigger a stale cancel.
		if (runningIds.has(t.id)) {
			const lastConfirm = runNowConfirm.get(t.id);
			const now = Date.now();
			if (lastConfirm && now - lastConfirm < 5000) {
				try {
					const res = await fetch('/api/scheduler/cancel', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ taskId: t.id }),
					});
					const data = await res.json();
					if (data.cancelled) flashToast('info', `${t.id}: cancel requested`);
					else flashToast('info', `${t.id}: no active run to cancel`);
				} catch (err) {
					flashToast('error', `Cancel failed: ${(err as Error).message}`);
				}
				const m = new Map(runNowConfirm);
				m.delete(t.id);
				runNowConfirm = m;
				return;
			}
			const m = new Map(runNowConfirm);
			m.set(t.id, now);
			runNowConfirm = m;
			flashToast('info', `${t.id} is running — click again to cancel`);
			return;
		}

		const next = new Set(runningIds);
		next.add(t.id);
		runningIds = next;

		try {
			const res = await fetch('/api/scheduler/run-now', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ taskId: t.id }),
			});
			const data = await res.json();
			if (data.ok) {
				flashToast('success', `${t.id} ran in ${data.durationMs}ms`);
			} else {
				flashToast('error', `${t.id} failed: ${data.error ?? 'unknown'}`);
			}
		} catch (err) {
			flashToast('error', `${t.id} run failed: ${(err as Error).message}`);
		} finally {
			const next2 = new Set(runningIds);
			next2.delete(t.id);
			runningIds = next2;
			loadTasks();
		}
	}

	async function toggleEnabled(t: Task) {
		try {
			const updatedTasks = tasks.map((existing) =>
				existing.id === t.id
					? { ...specShape(existing), enabled: !existing.enabled }
					: specShape(existing),
			);
			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scheduler: { tasks: updatedTasks } }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			flashToast('success', `${t.id} ${t.enabled ? 'disabled' : 'enabled'}`);
			loadTasks();
		} catch (err) {
			flashToast('error', `Save failed: ${(err as Error).message}`);
		}
	}

	function specShape(t: Task) {
		// Strip runtime fields so we POST only the persistable spec back.
		return {
			id: t.id,
			type: t.type,
			cron: t.cron,
			timezone: t.timezone ?? undefined,
			enabled: t.enabled,
			noOverlap: t.noOverlap,
			description: t.description ?? undefined,
			params: t.params,
		};
	}

	function flashToast(kind: 'success' | 'error' | 'info', text: string) {
		toast = { kind, text };
		setTimeout(() => {
			toast = null;
		}, 3500);
	}

	const summary = $derived.by(() => {
		const total = tasks.length;
		const active = tasks.filter((t) => t.enabled).length;
		const failed = tasks.filter((t) => t.lastStatus === 'error').length;
		const next = tasks
			.filter((t) => t.enabled && t.nextRunAt)
			.map((t) => new Date(t.nextRunAt!).getTime())
			.sort((a, b) => a - b)[0];
		const nextLabel = next ? relativeTime(new Date(next).toISOString()) : '—';
		return { total, active, failed, nextLabel };
	});

	onMount(() => {
		loadTasks();
		// Refresh every 30s so the relative-time labels and last-run pills stay live.
		pollInterval = setInterval(loadTasks, 30_000);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});
</script>

<svelte:head>
	<title>Scheduler · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-screen bg-hub-bg" data-scheduler>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<a
				href="/"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to home"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text">Scheduler</h1>
			</div>
			<div class="flex-1"></div>
			<a
				href="/scheduler/builder"
				class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer"
			>
				+ New task
			</a>
		</div>
	</header>

	<!-- Summary strip -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-hub-muted">
			<span><span class="text-hub-text font-medium">{summary.total}</span> tasks</span>
			<span class="text-hub-dim">·</span>
			<span><span class="text-hub-cta font-medium">{summary.active}</span> active</span>
			{#if summary.failed > 0}
				<span class="text-hub-dim">·</span>
				<span class="text-hub-danger"><span class="font-medium">{summary.failed}</span> failed</span>
			{/if}
			<span class="text-hub-dim">·</span>
			<span>next fire {summary.nextLabel}</span>
		</div>
	</div>

	<!-- Filter + search -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-3">
			<div class="flex items-center gap-1.5">
				{#each ['all', 'active', 'failed', 'ai-suggested'] as f (f)}
					<button
						onclick={() => (filter = f as FilterMode)}
						class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
							{filter === f
								? 'bg-hub-cta text-black'
								: 'bg-hub-card text-hub-muted hover:text-hub-text border border-hub-border'}"
					>
						{f === 'ai-suggested' ? 'AI-suggested' : f.charAt(0).toUpperCase() + f.slice(1)}
					</button>
				{/each}
			</div>
			<div class="flex-1 min-w-[180px]">
				<input
					type="search"
					bind:value={search}
					placeholder="Search by name…"
					class="w-full px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-xs text-hub-text placeholder-hub-dim focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
				/>
			</div>
		</div>
	</div>

	<!-- Task list -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full">
			{#if loading}
				<div class="space-y-2">
					{#each Array(4) as _, i (i)}
						<div class="h-16 bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{:else if loadError}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load tasks: {loadError}
				</div>
			{:else if filteredTasks.length === 0}
				<div class="bg-hub-card rounded-xl border border-hub-border p-12 text-center">
					{#if tasks.length === 0}
						<h3 class="text-base font-semibold text-hub-text mb-2">No scheduled tasks yet</h3>
						<p class="text-sm text-hub-muted mb-4">Create one to start automating recurring work.</p>
						<a
							href="/scheduler/builder"
							class="inline-block px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer"
						>
							Create your first task
						</a>
					{:else}
						<p class="text-sm text-hub-muted">No tasks match this filter.</p>
					{/if}
				</div>
			{:else}
				<div class="space-y-2">
					{#each filteredTasks as t (t.id)}
						<div class="bg-hub-card rounded-xl border border-hub-border overflow-hidden">
							<!-- Row -->
							<div class="px-4 py-3 grid grid-cols-1 md:grid-cols-[auto_1fr_auto_auto_auto] gap-4 items-start md:items-center">
								<!-- Status pill (sm shows inline; md starts row) -->
								<div class="md:pr-2">
									<StatusPill state={pillState(t)} />
								</div>

								<!-- Name + provenance + description -->
								<div class="min-w-0">
									<div class="flex items-center gap-2 mb-0.5">
										<h3 class="text-sm font-semibold text-hub-text truncate">{t.id}</h3>
										{#if isAiSuggested(t)}
											<span
												title="AI-suggested task"
												class="text-hub-purple flex-shrink-0"
											>
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>
												</svg>
											</span>
										{/if}
										<span class="text-[10px] text-hub-dim font-mono px-1.5 py-0.5 bg-hub-bg rounded border border-hub-border/60 flex-shrink-0">{t.type}</span>
									</div>
									{#if t.description}
										<p class="text-xs text-hub-muted truncate">{t.description}</p>
									{/if}
								</div>

								<!-- Schedule cell -->
								<div class="min-w-[200px]">
									<CronExpression value={t.cron} timezone={t.timezone} mode="compact" />
								</div>

								<!-- Last / Next cell -->
								<div class="text-xs text-hub-muted min-w-[140px]">
									<div class="flex items-center gap-1.5">
										{#if t.lastStatus === 'success'}
											<span class="text-hub-cta">✓</span>
										{:else if t.lastStatus === 'error'}
											<span class="text-hub-danger">✗</span>
										{:else}
											<span class="text-hub-dim">○</span>
										{/if}
										<span>{relativeTime(t.lastRunAt)}</span>
										{#if durationOf(t)}
											<span class="text-hub-dim">· {durationOf(t)}</span>
										{/if}
									</div>
									{#if t.enabled && t.nextRunAt}
										<div class="text-[11px] text-hub-dim mt-0.5">
											next {relativeTime(t.nextRunAt)}
										</div>
									{/if}
									{#if lastErrorExcerpt(t)}
										<div class="text-[10px] text-hub-danger mt-0.5 truncate" title={lastErrorExcerpt(t)}>
											{lastErrorExcerpt(t)}
										</div>
									{/if}
								</div>

								<!-- Actions -->
								<div class="flex items-center gap-1.5 flex-shrink-0">
									{#if t.enabled}
										{@const isRunning = runningIds.has(t.id)}
										{@const inConfirm = runNowConfirm.has(t.id)}
										<button
											onclick={() => runNow(t)}
											class="px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
												{inConfirm
													? 'bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25'
													: 'bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25'}"
											title={isRunning ? 'Click to cancel' : 'Run now'}
										>
											{inConfirm ? '✗ Cancel?' : isRunning ? 'Running… ✕' : '▶ Run now'}
										</button>
									{:else}
										<button
											onclick={() => toggleEnabled(t)}
											class="px-2 py-1 rounded-md text-[11px] font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer"
											title="Enable task"
										>
											⏵ Enable
										</button>
									{/if}
									{#if isEditable(t)}
										<a
											href="/scheduler/builder?id={encodeURIComponent(t.id)}"
											class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
											title="Edit task"
										>
											✎ Edit
										</a>
									{/if}
									{#if t.enabled}
										<button
											onclick={() => toggleEnabled(t)}
											class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-dim hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
											title="Disable task"
										>
											⏸
										</button>
									{/if}
									<button
										onclick={() => toggleExpand(t.id)}
										class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
										title="Toggle history"
										aria-expanded={expandedIds.has(t.id)}
									>
										↳ History ({t.recentHistory.length})
									</button>
								</div>
							</div>

							<!-- Expanded history -->
							{#if expandedIds.has(t.id)}
								<div class="bg-hub-bg/50 border-t border-hub-border/60">
									{#if t.recentHistory.length === 0}
										<div class="px-3 py-3 text-xs text-hub-dim text-center">No runs yet</div>
									{:else}
										<div class="grid grid-cols-[80px_180px_80px_1fr] gap-3 px-3 py-1.5 border-b border-hub-border/40 text-[10px] uppercase tracking-wide text-hub-dim font-medium">
											<div>Status</div>
											<div>Started</div>
											<div>Duration</div>
											<div>Output</div>
										</div>
										{#each t.recentHistory as run (run.id)}
											<RunHistoryRow row={run} />
										{/each}
										<div class="px-3 py-2 text-[10px] text-hub-dim flex items-center gap-3">
											<span>Showing {t.recentHistory.length} most-recent runs</span>
											{#if t.nextRunAt}
												<span class="text-hub-dim">·</span>
												<span>next at {absoluteTime(t.nextRunAt, t.timezone)}</span>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Toast -->
	{#if toast}
		<div
			class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg
				{toast.kind === 'success' ? 'bg-hub-cta text-black'
				: toast.kind === 'error' ? 'bg-hub-danger text-white'
				: 'bg-hub-card text-hub-text border border-hub-border'}"
			role="status"
		>
			{toast.text}
		</div>
	{/if}
</div>
