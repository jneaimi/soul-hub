<script lang="ts">
	import { page } from '$app/stores';
	import RenderedMarkdown from '$lib/components/RenderedMarkdown.svelte';
	import DecisionActions from '$lib/components/projects/DecisionActions.svelte';
	import AdrDrawer from '$lib/components/projects/AdrDrawer.svelte';

	interface DecisionRow {
		path: string;
		title: string;
		status: string;
		created: string | null;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
		blockedBy: string[];
	}

	interface ProjectDetail {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: { proposed: number; accepted: number; shipped: number; rejected: number; parked: number; other: number };
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
		hasIndex: boolean;
		indexPath: string | null;
		decisions?: DecisionRow[];
	}

	let detail = $state<ProjectDetail | null>(null);
	let loading = $state(true);
	let error = $state('');
	let drawerPath = $state<string | null>(null);

	let planExpanded = $state(false);
	let planHtml = $state('');
	let planLoaded = $state(false);
	let planLoading = $state(false);
	let planError = $state('');

	const slug = $derived($page.params.slug);
	const decisions = $derived(detail?.decisions ?? []);
	const proposed = $derived(decisions.filter((d) => d.status === 'proposed'));
	const others = $derived(decisions.filter((d) => d.status !== 'proposed'));

	async function load() {
		error = '';
		loading = true;
		try {
			const res = await fetch(`/api/vault/projects?slug=${encodeURIComponent(slug)}`);
			if (!res.ok) throw new Error(`Project load: ${res.status}`);
			const data = await res.json();
			detail = (data.projects ?? [])[0] ?? null;
			// Reset plan preview state when slug changes
			planExpanded = false;
			planLoaded = false;
			planHtml = '';
			planError = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Load failed';
		} finally {
			loading = false;
		}
	}

	async function loadPlan() {
		if (!detail?.indexPath || planLoaded || planLoading) return;
		planLoading = true;
		planError = '';
		try {
			const res = await fetch(`/api/vault/notes/${detail.indexPath}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			planHtml = data.rendered ?? '';
			planLoaded = true;
		} catch (e) {
			planError = e instanceof Error ? e.message : 'Failed to load plan';
		} finally {
			planLoading = false;
		}
	}

	function togglePlan() {
		planExpanded = !planExpanded;
		if (planExpanded && !planLoaded) loadPlan();
	}

	function handleTransition(info: { path: string; action: 'accept' | 'reject' | 'park'; newStatus: string }) {
		// Reload to refresh both the per-decision row AND the rollup counts.
		// Cheap on a single-project endpoint.
		load();
	}

	function timeAgoMs(ms: number | null): string {
		if (!ms) return '—';
		const diff = Date.now() - ms;
		const mins = Math.floor(diff / 60_000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}

	function statusClass(status: string): string {
		if (status === 'proposed') return 'bg-hub-warning/15 text-hub-warning';
		if (status === 'accepted') return 'bg-hub-info/15 text-hub-info';
		if (status.startsWith('shipped')) return 'bg-hub-cta/15 text-hub-cta';
		if (status === 'rejected') return 'bg-hub-danger/15 text-hub-danger';
		if (status === 'parked') return 'bg-hub-dim/15 text-hub-dim';
		return 'bg-hub-card text-hub-dim';
	}

	function falsifierClass(daysAway: number | null): string {
		if (daysAway === null) return 'text-hub-dim';
		if (daysAway <= 7) return 'text-hub-danger';
		if (daysAway <= 30) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	$effect(() => { if (slug) load(); });
</script>

<svelte:head>
	<title>{slug} | Projects | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center gap-3 mb-2">
				<a href="/projects" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text" aria-label="Back to projects">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
					</svg>
				</a>
				<h1 class="text-lg font-semibold text-hub-text truncate">{slug}</h1>
				{#if detail}
					<span class="text-hub-dim text-sm">{detail.adrCount} ADR{detail.adrCount === 1 ? '' : 's'} · {detail.noteCount} note{detail.noteCount === 1 ? '' : 's'}</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{:else if !detail}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">Project not found in vault</p>
					<p class="text-hub-dim text-xs">No folder at <code class="font-mono">~/vault/projects/{slug}/</code>.</p>
				</div>
			{:else}
				<!-- Stat cards -->
				<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-6">
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Proposed</div>
						<div class="text-lg font-semibold text-hub-warning">{detail.statusCounts.proposed}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Accepted</div>
						<div class="text-lg font-semibold text-hub-info">{detail.statusCounts.accepted}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Shipped</div>
						<div class="text-lg font-semibold text-hub-cta">{detail.statusCounts.shipped}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Parked</div>
						<div class="text-lg font-semibold text-hub-dim">{detail.statusCounts.parked}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Last activity</div>
						<div class="text-sm font-medium text-hub-text">{timeAgoMs(detail.lastActivity)}</div>
					</div>
				</div>

				<!-- Plan / index.md preview -->
				{#if detail.indexPath}
					<section class="mb-6 border border-hub-border rounded-lg bg-hub-card/40 overflow-hidden">
						<div class="w-full flex items-center justify-between px-4 py-3 hover:bg-hub-card/60 transition-colors">
							<button
								onclick={togglePlan}
								class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer text-left"
								aria-expanded={planExpanded}
							>
								<svg class="w-4 h-4 text-hub-dim transition-transform" style:transform={planExpanded ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="9 18 15 12 9 6"/>
								</svg>
								<span class="text-sm font-medium text-hub-text">Plan</span>
								<span class="text-[11px] font-mono text-hub-dim truncate">{detail.indexPath}</span>
							</button>
							<button
								onclick={() => drawerPath = detail!.indexPath}
								class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer px-2 py-1 rounded hover:bg-hub-card flex-shrink-0 ml-2"
							>
								Open viewer →
							</button>
						</div>
						{#if planExpanded}
							<div class="px-4 pb-4 border-t border-hub-border">
								{#if planLoading}
									<p class="text-xs text-hub-muted py-3">Loading plan…</p>
								{:else if planError}
									<p class="text-xs text-hub-danger py-3">{planError}</p>
								{:else if planHtml}
									<div class="pt-3">
										<RenderedMarkdown html={planHtml} />
									</div>
								{:else}
									<p class="text-xs text-hub-dim py-3">Plan is empty.</p>
								{/if}
							</div>
						{/if}
					</section>
				{/if}

				<!-- Falsifier alerts -->
				{#if detail.upcomingFalsifiers.length > 0}
					<div class="mb-6 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="text-xs font-medium text-hub-warning mb-2">Upcoming falsifier dates</div>
						<div class="space-y-1">
							{#each detail.upcomingFalsifiers as f}
								<button
									onclick={() => drawerPath = f.path}
									class="w-full flex items-center justify-between text-xs hover:bg-hub-card/60 px-1 py-0.5 rounded transition-colors cursor-pointer text-left"
								>
									<span class="font-mono text-hub-text truncate">{f.path.split('/').pop()}</span>
									<span class="text-hub-warning ml-2 flex-shrink-0">⏱ {f.daysAway}d ({f.date})</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Awaiting decision (proposed) -->
				{#if proposed.length > 0}
					<section class="mb-6">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-semibold text-hub-warning">
								Awaiting decision ({proposed.length})
							</h2>
							<a href="/projects/queue" class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer">View full queue →</a>
						</div>
						<div class="space-y-3">
							{#each proposed as d (d.path)}
								<div class="border border-hub-warning/25 rounded-lg bg-hub-warning/5 p-4">
									<div class="flex items-start justify-between gap-3 mb-2">
										<button
											onclick={() => drawerPath = d.path}
											class="min-w-0 flex-1 text-left cursor-pointer group"
										>
											<div class="flex items-center gap-2 text-[11px] text-hub-dim mb-1">
												{#if d.created}<span>{d.created}</span>{/if}
												{#if d.falsifierDate && d.falsifierDaysAway !== null}
													<span>·</span>
													<span class={falsifierClass(d.falsifierDaysAway)}>
														⏱ {d.falsifierDaysAway}d → {d.falsifierDate}
													</span>
												{/if}
												{#if d.blockedBy.length > 0}
													<span>·</span>
													<span class="text-hub-warning">blocked by {d.blockedBy.length}</span>
												{/if}
											</div>
											<h3 class="text-sm font-semibold text-hub-text group-hover:text-hub-info transition-colors">
												{d.title}
											</h3>
											<p class="text-[11px] text-hub-dim font-mono truncate mt-1">{d.path}</p>
										</button>
										<DecisionActions path={d.path} size="md" onTransition={handleTransition} />
									</div>
									{#if d.tags.length > 0}
										<div class="flex flex-wrap items-center gap-1 mt-2">
											{#each d.tags.slice(0, 6) as tag}
												<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- All other decisions -->
				<section>
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-semibold text-hub-text">
							{proposed.length > 0 ? 'Other decisions' : 'Decisions'} ({others.length})
						</h2>
						{#if proposed.length === 0}
							<a href="/projects/queue" class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer">View queue →</a>
						{/if}
					</div>

					{#if others.length === 0 && proposed.length === 0}
						<p class="text-hub-dim text-xs py-6 text-center">No decisions yet for this project.</p>
					{:else if others.length === 0}
						<p class="text-hub-dim text-xs py-3 text-center">All other decisions cleared.</p>
					{:else}
						<div class="divide-y divide-hub-border/60 border border-hub-border rounded-lg bg-hub-card/40">
							{#each others as d (d.path)}
								<button
									onclick={() => drawerPath = d.path}
									class="w-full px-4 py-3 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
								>
									<div class="flex items-center gap-2 min-w-0">
										{#if d.status}
											<span class="text-[10px] px-1.5 py-0.5 rounded {statusClass(d.status)} flex-shrink-0">
												{d.status}
											</span>
										{/if}
										<span class="text-sm font-medium text-hub-text truncate flex-1">
											{d.title}
										</span>
										{#if d.tags.length > 0}
											<div class="flex items-center gap-1 flex-shrink-0">
												{#each d.tags.slice(0, 3) as tag}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
												{/each}
											</div>
										{/if}
									</div>
									<div class="text-[11px] text-hub-dim font-mono truncate mt-0.5">
										{d.path}
										{#if d.created}<span class="ml-2">· {d.created}</span>{/if}
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>
			{/if}
		</div>
	</div>
</div>

<AdrDrawer
	path={drawerPath}
	onClose={() => drawerPath = null}
	onTransition={handleTransition}
/>
