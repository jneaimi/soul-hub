<script lang="ts">
	import { onMount } from 'svelte';

	interface QueueRow {
		path: string;
		title: string;
		project: string;
		status: string;
		created: string | null;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
		blockedBy: string[];
	}

	let rows = $state<QueueRow[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actingPath = $state<string | null>(null);
	let actionResult = $state<{ path: string; status: string; message: string } | null>(null);

	// Per-row reject form state
	let rejectingPath = $state<string | null>(null);
	let rejectReason = $state('');
	let parkingPath = $state<string | null>(null);
	let parkReviewAfter = $state('');

	async function load() {
		error = '';
		try {
			const res = await fetch('/api/vault/decisions/queue');
			if (!res.ok) throw new Error(`Queue load failed: ${res.status}`);
			const data = await res.json();
			rows = data.decisions ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load queue';
		} finally {
			loading = false;
		}
	}

	async function transition(
		path: string,
		action: 'accept' | 'reject' | 'park',
		body: Record<string, unknown> = {},
	) {
		actingPath = path;
		actionResult = null;
		try {
			const res = await fetch('/api/vault/decisions/transition', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, action, ...body }),
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				actionResult = {
					path,
					status: 'error',
					message: data.error ?? `HTTP ${res.status}`,
				};
				return;
			}
			actionResult = {
				path,
				status: 'ok',
				message: `${action} → ${data.newStatus}`,
			};
			// Drop the row optimistically (server already mutated)
			rows = rows.filter((r) => r.path !== path);
			rejectingPath = null;
			parkingPath = null;
			rejectReason = '';
			parkReviewAfter = '';
		} catch (e) {
			actionResult = {
				path,
				status: 'error',
				message: e instanceof Error ? e.message : 'Network error',
			};
		} finally {
			actingPath = null;
		}
	}

	function falsifierClass(daysAway: number | null): string {
		if (daysAway === null) return 'text-hub-dim';
		if (daysAway <= 0) return 'text-hub-danger';
		if (daysAway <= 7) return 'text-hub-danger';
		if (daysAway <= 30) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	function falsifierLabel(daysAway: number | null, date: string | null): string {
		if (daysAway === null || !date) return '';
		if (daysAway < 0) return `expired ${-daysAway}d ago`;
		if (daysAway === 0) return 'expires today';
		return `${daysAway}d → ${date}`;
	}

	onMount(() => { load(); });
</script>

<svelte:head>
	<title>Decision Queue | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header + sub-nav -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center justify-between mb-3">
				<div class="flex items-center gap-3">
					<h1 class="text-lg font-semibold text-hub-text">Decision Queue</h1>
					{#if rows.length > 0}
						<span class="text-hub-dim font-normal text-sm">({rows.length} awaiting)</span>
					{/if}
				</div>
				<div class="text-xs text-hub-dim">
					Oldest first · accept clears one click · reject requires a reason
				</div>
			</div>
			<nav class="flex items-center gap-1 text-xs">
				<a href="/projects" class="px-3 py-1.5 rounded-md text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
					All
				</a>
				<a href="/projects/queue" class="px-3 py-1.5 rounded-md bg-hub-card text-hub-text">
					Decision Queue
				</a>
			</nav>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading queue…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-6 flex items-center justify-between">
					<span>{error}</span>
					<button onclick={() => load()} class="text-xs underline cursor-pointer">Retry</button>
				</div>
			{:else if rows.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">Queue empty.</p>
					<p class="text-hub-dim text-xs">No proposed ADRs across any vault project.</p>
				</div>
			{:else}
				<div class="space-y-3">
					{#each rows as row (row.path)}
						<div class="border border-hub-border rounded-lg bg-hub-card/40 p-4">
							<div class="flex items-start justify-between gap-3 mb-2">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2 text-[11px] text-hub-dim mb-1">
										<a href="/projects/{row.project}" class="text-hub-info hover:text-hub-text transition-colors cursor-pointer">{row.project || '—'}</a>
										{#if row.created}
											<span>·</span>
											<span>{row.created}</span>
										{/if}
										{#if row.falsifierDate && row.falsifierDaysAway !== null}
											<span>·</span>
											<span class={falsifierClass(row.falsifierDaysAway)}>
												⏱ {falsifierLabel(row.falsifierDaysAway, row.falsifierDate)}
											</span>
										{/if}
										{#if row.blockedBy.length > 0}
											<span>·</span>
											<span class="text-hub-warning">blocked by {row.blockedBy.length}</span>
										{/if}
									</div>
									<h3 class="text-sm font-semibold text-hub-text truncate">
										{row.title}
									</h3>
									<p class="text-[11px] text-hub-dim font-mono truncate mt-1">{row.path}</p>
								</div>
								<div class="flex items-center gap-1 flex-shrink-0">
									<button
										onclick={() => transition(row.path, 'accept')}
										disabled={actingPath === row.path}
										class="px-3 py-1.5 rounded text-xs font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
									>
										{actingPath === row.path ? '…' : 'Accept'}
									</button>
									<button
										onclick={() => { rejectingPath = rejectingPath === row.path ? null : row.path; parkingPath = null; }}
										disabled={actingPath === row.path}
										class="px-3 py-1.5 rounded text-xs font-medium bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25 transition-colors cursor-pointer disabled:opacity-50"
									>
										Reject
									</button>
									<button
										onclick={() => { parkingPath = parkingPath === row.path ? null : row.path; rejectingPath = null; }}
										disabled={actingPath === row.path}
										class="px-3 py-1.5 rounded text-xs font-medium bg-hub-dim/15 text-hub-dim hover:bg-hub-dim/25 transition-colors cursor-pointer disabled:opacity-50"
									>
										Park
									</button>
								</div>
							</div>

							{#if row.tags.length > 0}
								<div class="flex flex-wrap items-center gap-1 mt-2">
									{#each row.tags.slice(0, 6) as tag}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
									{/each}
									{#if row.tags.length > 6}
										<span class="text-[10px] text-hub-dim">+{row.tags.length - 6}</span>
									{/if}
								</div>
							{/if}

							{#if rejectingPath === row.path}
								<div class="mt-3 p-3 rounded-lg bg-hub-surface border border-hub-danger/30">
									<label class="block text-[11px] font-medium text-hub-danger mb-1">
										Reason for reject (required)
									</label>
									<textarea
										bind:value={rejectReason}
										rows="2"
										placeholder="Why is this rejected? Any context for future-you."
										class="w-full bg-transparent border border-hub-border rounded px-2 py-1.5 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-danger/50 transition-colors resize-none"
									></textarea>
									<div class="flex items-center gap-2 mt-2">
										<button
											onclick={() => transition(row.path, 'reject', { reason: rejectReason })}
											disabled={!rejectReason.trim() || actingPath === row.path}
											class="px-3 py-1 rounded text-[11px] font-medium bg-hub-danger text-white hover:bg-hub-danger/90 transition-colors cursor-pointer disabled:opacity-50"
										>
											Confirm reject
										</button>
										<button
											onclick={() => { rejectingPath = null; rejectReason = ''; }}
											class="px-3 py-1 rounded text-[11px] text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
										>
											Cancel
										</button>
									</div>
								</div>
							{/if}

							{#if parkingPath === row.path}
								<div class="mt-3 p-3 rounded-lg bg-hub-surface border border-hub-dim/30">
									<label class="block text-[11px] font-medium text-hub-dim mb-1">
										Review after (optional, YYYY-MM-DD)
									</label>
									<input
										bind:value={parkReviewAfter}
										type="text"
										placeholder="2026-06-30"
										pattern="\d{'{4}'}-\d{'{2}'}-\d{'{2}'}"
										class="w-full bg-transparent border border-hub-border rounded px-2 py-1.5 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
									/>
									<div class="flex items-center gap-2 mt-2">
										<button
											onclick={() => transition(row.path, 'park', parkReviewAfter ? { reviewAfter: parkReviewAfter } : {})}
											disabled={actingPath === row.path}
											class="px-3 py-1 rounded text-[11px] font-medium bg-hub-dim text-hub-text hover:bg-hub-dim/80 transition-colors cursor-pointer disabled:opacity-50"
										>
											Confirm park
										</button>
										<button
											onclick={() => { parkingPath = null; parkReviewAfter = ''; }}
											class="px-3 py-1 rounded text-[11px] text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
										>
											Cancel
										</button>
									</div>
								</div>
							{/if}

							{#if actionResult && actionResult.path === row.path}
								<div
									class="mt-2 px-2 py-1 rounded text-[11px]"
									class:bg-hub-info={actionResult.status === 'ok'}
									class:text-white={actionResult.status === 'ok'}
									class:bg-hub-danger={actionResult.status === 'error'}
								>
									{actionResult.message}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
