<script lang="ts">
	import { page } from '$app/stores';
	import RenderedMarkdown from '$lib/components/RenderedMarkdown.svelte';
	import DecisionActions from '$lib/components/projects/DecisionActions.svelte';
	import AdrDrawer from '$lib/components/projects/AdrDrawer.svelte';
	import AdrGantt from '$lib/components/projects/AdrGantt.svelte';

	type PhaseStatus = 'proposed' | 'accepted' | 'shipped' | 'parked' | 'superseded' | 'rejected' | 'unknown';

	interface Phase {
		id: string;
		ordinal: number;
		label: string;
		status: PhaseStatus;
		shipped_at?: string;
		target_date?: string;
		falsifier_date?: string;
		commit?: string;
		source: 'adr-body' | 'project-index' | 'frontmatter';
		scope?: string;
		raw_marker: string;
		qualifiers: string[];
	}

	interface DecisionRow {
		path: string;
		title: string;
		status: string;
		created: string | null;
		acceptedOn: string | null;
		shippedOn: string | null;
		targetDate: string | null;
		dateInferred: boolean;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
		blockedBy: string[];
		phases?: Phase[];
	}

	interface NextActionsResponse {
		project: string;
		generated_at: string;
		open_phases: Phase[];
		blocked_phases: Phase[];
		recent_shipped: Phase[];
		next: Phase | null;
	}

	interface ProjectDetail {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: { proposed: number; accepted: number; shipped: number; rejected: number; parked: number; superseded: number; other: number };
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
		hasIndex: boolean;
		indexPath: string | null;
		/** PROJECT-LEVEL phases from the index roadmap. Rendered once in
		 *  its own section, not duplicated under every ADR. */
		projectPhases?: Phase[];
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

	let timelineExpanded = $state(true);

	// project-phases P3: phase tree expansion state + next-actions cache.
	// Expanded decisions show their phase[] inline. The next-actions endpoint
	// is fetched separately so the "Next up" strip + phase counts work even
	// when individual decision rows are collapsed.
	let expandedDecisions = $state<Set<string>>(new Set());
	let nextActions = $state<NextActionsResponse | null>(null);
	let roadmapExpanded = $state(true);

	const slug = $derived($page.params.slug);
	const decisions = $derived(detail?.decisions ?? []);
	const proposed = $derived(decisions.filter((d) => d.status === 'proposed'));
	const others = $derived(decisions.filter((d) => d.status !== 'proposed'));

	// Phase rollup across BOTH project-level and ADR-level phases.
	// Dedupes in two stages:
	//   1. By phase.id — catches exact duplicates.
	//   2. Project-index phases are dropped when an adr-body phase claims
	//      the same ordinal (e.g. ADR-003 declaring "**Phase 1 SHIPPED**"
	//      IS the project's P1 milestone; counting both would inflate).
	// Project-index-only phases never participate in the blocked-check —
	// that's an ADR-level signal.
	const phaseRollup = $derived.by(() => {
		const seen = new Set<string>();
		let shipped = 0;
		let open = 0;
		let blocked = 0;
		const blockedAdrPaths = new Set(
			(nextActions?.blocked_phases ?? []).map((p) => p.id.split('#')[0])
		);
		const adrBodyOrdinals = new Set<number>();
		for (const d of decisions) {
			for (const p of d.phases ?? []) {
				if (p.source === 'adr-body') adrBodyOrdinals.add(p.ordinal);
			}
		}
		const tally = (p: Phase) => {
			if (seen.has(p.id)) return;
			seen.add(p.id);
			if (p.status === 'shipped') shipped++;
			else if (p.status === 'proposed' || p.status === 'accepted') {
				if (blockedAdrPaths.has(p.id.split('#')[0]) && p.source === 'adr-body') blocked++;
				else open++;
			}
		};
		for (const p of detail?.projectPhases ?? []) {
			if (p.source === 'project-index' && adrBodyOrdinals.has(p.ordinal)) continue;
			tally(p);
		}
		for (const d of decisions) {
			for (const p of d.phases ?? []) tally(p);
		}
		return { shipped, open, blocked, total: seen.size };
	});

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
			expandedDecisions = new Set();
			// Fire-and-forget next-actions fetch (separate state path so the
			// main page renders even if this endpoint is slow/fails).
			loadNextActions();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Load failed';
		} finally {
			loading = false;
		}
	}

	async function loadNextActions() {
		if (!slug) return;
		try {
			const res = await fetch(`/api/vault/projects/${encodeURIComponent(slug)}/next-actions`);
			if (!res.ok) {
				nextActions = null;
				return;
			}
			nextActions = await res.json();
		} catch {
			nextActions = null;
		}
	}

	function toggleDecisionExpand(path: string) {
		const next = new Set(expandedDecisions);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedDecisions = next;
	}

	function phaseStatusClass(status: PhaseStatus): string {
		if (status === 'shipped') return 'bg-hub-cta/15 text-hub-cta';
		if (status === 'accepted') return 'bg-hub-info/15 text-hub-info';
		if (status === 'proposed') return 'bg-hub-warning/15 text-hub-warning';
		if (status === 'parked') return 'bg-hub-dim/15 text-hub-dim';
		if (status === 'superseded') return 'bg-hub-muted/15 text-hub-muted line-through';
		if (status === 'rejected') return 'bg-hub-danger/15 text-hub-danger';
		return 'bg-hub-card text-hub-dim';
	}

	function adrSlugFromId(phaseId: string): string {
		return phaseId.split('#')[0];
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

	function handleTransition(info: { path: string; action: 'accept' | 'reject' | 'park' | 'ship'; newStatus: string }) {
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
		if (status === 'shipped') return 'bg-hub-cta/15 text-hub-cta';
		if (status === 'rejected') return 'bg-hub-danger/15 text-hub-danger';
		if (status === 'parked') return 'bg-hub-dim/15 text-hub-dim';
		if (status === 'superseded') return 'bg-hub-muted/15 text-hub-muted line-through';
		return 'bg-hub-card text-hub-dim';
	}

	function falsifierClass(daysAway: number | null): string {
		if (daysAway === null) return 'text-hub-dim';
		if (daysAway <= 7) return 'text-hub-danger';
		if (daysAway <= 30) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	/** Human-readable explanation of why a date is coloured the way it is.
	 *  Surfaces as a `title` attribute on falsifier badges + dates so the
	 *  reader can hover to learn the threshold without us having to print
	 *  the legend everywhere. Same buckets as `falsifierClass` and the
	 *  Gantt's `falsifierFill` — single source of truth in spec, even
	 *  though the function lives in three places (one per consumer). */
	function falsifierMeaning(daysAway: number | null): string {
		if (daysAway === null) return 'No falsifier date set';
		if (daysAway < 0) return `Overdue by ${Math.abs(daysAway)}d — review past due`;
		if (daysAway <= 7) return `Due within 7 days — urgent review`;
		if (daysAway <= 30) return `Due within 30 days — review soon`;
		return `>30 days away — on track`;
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
				<!-- Stat cards. Superseded + Rejected only render when non-zero
				     to keep the row tight for the common case. -->
				<div class="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-6 gap-2 mb-6">
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
					{#if detail.statusCounts.superseded > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Superseded</div>
							<div class="text-lg font-semibold text-hub-muted">{detail.statusCounts.superseded}</div>
						</div>
					{/if}
					{#if detail.statusCounts.rejected > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Rejected</div>
							<div class="text-lg font-semibold text-hub-danger">{detail.statusCounts.rejected}</div>
						</div>
					{/if}
					{#if phaseRollup.total > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border" title="From phase-parser across all ADRs in this project (project-phases ADR-001)">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Phases</div>
							<div class="text-sm font-medium text-hub-text">
								<span class="text-hub-cta">{phaseRollup.shipped}</span>
								<span class="text-hub-dim">/</span>
								<span class="text-hub-warning">{phaseRollup.open}</span>
								{#if phaseRollup.blocked > 0}<span class="text-hub-dim">/</span><span class="text-hub-danger">{phaseRollup.blocked}</span>{/if}
							</div>
							<div class="text-[10px] text-hub-dim mt-0.5">
								shipped / open{phaseRollup.blocked > 0 ? ' / blocked' : ''}
							</div>
						</div>
					{/if}
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Last activity</div>
						<div class="text-sm font-medium text-hub-text">{timeAgoMs(detail.lastActivity)}</div>
					</div>
				</div>

				<!-- Next up strip (project-phases P3). Surfaces the open phase
				     with the nearest falsifier across all ADRs. Hidden when
				     no open phases exist (all shipped, or no parseable data). -->
				{#if nextActions?.next}
					<div class="mb-6 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5 flex items-center gap-3 flex-wrap">
						<span class="text-[10px] uppercase tracking-wider text-hub-info font-semibold">Next up</span>
						<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(nextActions.next.status)} flex-shrink-0">
							{nextActions.next.status}
						</span>
						<span class="text-sm font-medium text-hub-text">{nextActions.next.label}</span>
						{#if nextActions.next.source === 'adr-body'}
							<span class="text-[11px] font-mono text-hub-dim truncate">{adrSlugFromId(nextActions.next.id)}</span>
						{/if}
						{#if nextActions.next.scope}
							<span class="text-xs text-hub-muted truncate flex-1 min-w-0">{nextActions.next.scope}</span>
						{/if}
						{#if nextActions.next.falsifier_date}
							<span class="text-[11px] text-hub-warning flex-shrink-0">⏱ {nextActions.next.falsifier_date}</span>
						{/if}
					</div>
				{/if}

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

				<!-- Timeline (Gantt) — Phase 3c. Renders if there are any dated decisions. -->
				{#if decisions.length > 0}
					<section class="mb-6 border border-hub-border rounded-lg bg-hub-card/40 overflow-hidden">
						<button
							onclick={() => (timelineExpanded = !timelineExpanded)}
							class="w-full flex items-center gap-2 px-4 py-3 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
							aria-expanded={timelineExpanded}
						>
							<svg class="w-4 h-4 text-hub-dim transition-transform" style:transform={timelineExpanded ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="9 18 15 12 9 6"/>
							</svg>
							<span class="text-sm font-medium text-hub-text">Timeline</span>
							<span class="text-[11px] text-hub-dim">{decisions.length} ADR{decisions.length === 1 ? '' : 's'}</span>
						</button>
						{#if timelineExpanded}
							<div class="px-4 pb-4 border-t border-hub-border">
								<div class="pt-3">
									<AdrGantt decisions={decisions} onSelect={(p) => (drawerPath = p)} />
								</div>
							</div>
						{/if}
					</section>
				{/if}

				<!-- Project roadmap (project-phases ADR-001 follow-up). The
				     project-level phase tree from the `## Roadmap` table in
				     index.md. Rendered ONCE here so the same milestones aren't
				     duplicated under every ADR. Per-ADR expansion below shows
				     only that ADR's own in-body markers. -->
				{#if detail.projectPhases && detail.projectPhases.length > 0}
					<section class="mb-6 border border-hub-border rounded-lg bg-hub-card/40 overflow-hidden">
						<button
							onclick={() => (roadmapExpanded = !roadmapExpanded)}
							class="w-full flex items-center gap-2 px-4 py-3 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
							aria-expanded={roadmapExpanded}
						>
							<svg class="w-4 h-4 text-hub-dim transition-transform" style:transform={roadmapExpanded ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="9 18 15 12 9 6"/>
							</svg>
							<span class="text-sm font-medium text-hub-text">Project roadmap</span>
							<span class="text-[11px] text-hub-dim">
								{detail.projectPhases.filter(p => p.status === 'shipped').length}/{detail.projectPhases.length} shipped
							</span>
						</button>
						{#if roadmapExpanded}
							<div class="px-4 pb-3 pt-1 border-t border-hub-border space-y-1">
								{#each detail.projectPhases as p (p.id)}
									<div class="flex items-center gap-2 text-xs py-0.5" title={p.raw_marker}>
										<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(p.status)} flex-shrink-0 min-w-[60px] text-center">{p.status}</span>
										<span class="font-medium text-hub-text flex-shrink-0">{p.label}</span>
										{#if p.scope}<span class="text-hub-dim truncate min-w-0">{p.scope}</span>{/if}
										{#if p.shipped_at}<span class="text-hub-cta text-[10px] flex-shrink-0">✓ {p.shipped_at}</span>{/if}
									</div>
								{/each}
							</div>
						{/if}
					</section>
				{/if}

				<!-- Falsifier alerts -->
				{#if detail.upcomingFalsifiers.length > 0}
					<div class="mb-6 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
							<div class="text-xs font-medium text-hub-warning">Upcoming falsifier dates</div>
							<!-- Urgency legend. Same thresholds as falsifierClass() and
							     AdrGantt.falsifierFill(). Hover any date row for the
							     exact meaning. -->
							<div class="flex items-center gap-3 text-[10px] text-hub-dim">
								<span class="inline-flex items-center gap-1" title="≤7 days — urgent review">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-danger"></span>≤7d
								</span>
								<span class="inline-flex items-center gap-1" title="≤30 days — review soon">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-warning"></span>≤30d
								</span>
								<span class="inline-flex items-center gap-1" title=">30 days — on track">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-dim/60"></span>&gt;30d
								</span>
							</div>
						</div>
						<div class="space-y-1">
							{#each detail.upcomingFalsifiers as f}
								<button
									onclick={() => drawerPath = f.path}
									class="w-full flex items-center justify-between text-xs hover:bg-hub-card/60 px-1 py-0.5 rounded transition-colors cursor-pointer text-left"
									title={falsifierMeaning(f.daysAway)}
								>
									<span class="font-mono text-hub-text truncate">{f.path.split('/').pop()}</span>
									<span class="{falsifierClass(f.daysAway)} ml-2 flex-shrink-0">⏱ {f.daysAway}d ({f.date})</span>
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
										{#if d.phases && d.phases.length > 0}
											<button
												onclick={() => toggleDecisionExpand(d.path)}
												class="flex-shrink-0 self-start p-1 -ml-1 rounded hover:bg-hub-card/60 cursor-pointer"
												aria-label="Toggle phases"
												aria-expanded={expandedDecisions.has(d.path)}
											>
												<svg class="w-3.5 h-3.5 text-hub-dim transition-transform" style:transform={expandedDecisions.has(d.path) ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<polyline points="9 18 15 12 9 6"/>
												</svg>
											</button>
										{/if}
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
									{#if expandedDecisions.has(d.path) && d.phases && d.phases.length > 0}
										<div class="mt-3 pt-3 border-t border-hub-warning/20 space-y-1">
											{#each d.phases as p (p.id)}
												<div class="flex items-center gap-2 text-xs py-0.5" title={p.raw_marker}>
													<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(p.status)} flex-shrink-0 min-w-[60px] text-center">{p.status}</span>
													<span class="font-medium text-hub-text flex-shrink-0">{p.label}</span>
													{#if p.scope}<span class="text-hub-dim truncate min-w-0">{p.scope}</span>{/if}
													{#if p.shipped_at}<span class="text-hub-cta text-[10px] flex-shrink-0">✓ {p.shipped_at}</span>{/if}
													{#if p.target_date && !p.shipped_at}<span class="text-hub-info text-[10px] flex-shrink-0">→ {p.target_date}</span>{/if}
													{#if p.commit}<span class="text-hub-dim font-mono text-[10px] flex-shrink-0">{p.commit.slice(0, 7)}</span>{/if}
												</div>
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
								<div>
									<div class="flex items-stretch hover:bg-hub-card/60 transition-colors">
										{#if d.phases && d.phases.length > 0}
											<button
												onclick={() => toggleDecisionExpand(d.path)}
												class="flex items-center justify-center px-3 cursor-pointer hover:bg-hub-card/80 transition-colors"
												aria-label="Toggle phases"
												aria-expanded={expandedDecisions.has(d.path)}
											>
												<svg class="w-3.5 h-3.5 text-hub-dim transition-transform" style:transform={expandedDecisions.has(d.path) ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<polyline points="9 18 15 12 9 6"/>
												</svg>
											</button>
										{:else}
											<div class="w-10 flex-shrink-0"></div>
										{/if}
										<button
											onclick={() => drawerPath = d.path}
											class="flex-1 min-w-0 px-4 py-3 text-left cursor-pointer"
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
												{#if d.phases && d.phases.length > 0}
													<span class="text-[10px] text-hub-dim flex-shrink-0">{d.phases.filter(p => p.status === 'shipped').length}/{d.phases.length} ph</span>
												{/if}
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
									</div>
									{#if expandedDecisions.has(d.path) && d.phases && d.phases.length > 0}
										<div class="px-4 pb-3 pt-1 ml-10 space-y-1 border-t border-hub-border/40">
											{#each d.phases as p (p.id)}
												<div class="flex items-center gap-2 text-xs py-0.5" title={p.raw_marker}>
													<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(p.status)} flex-shrink-0 min-w-[60px] text-center">{p.status}</span>
													<span class="font-medium text-hub-text flex-shrink-0">{p.label}</span>
													{#if p.scope}<span class="text-hub-dim truncate min-w-0">{p.scope}</span>{/if}
													{#if p.shipped_at}<span class="text-hub-cta text-[10px] flex-shrink-0">✓ {p.shipped_at}</span>{/if}
													{#if p.target_date && !p.shipped_at}<span class="text-hub-info text-[10px] flex-shrink-0">→ {p.target_date}</span>{/if}
													{#if p.commit}<span class="text-hub-dim font-mono text-[10px] flex-shrink-0">{p.commit.slice(0, 7)}</span>{/if}
												</div>
											{/each}
										</div>
									{/if}
								</div>
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
