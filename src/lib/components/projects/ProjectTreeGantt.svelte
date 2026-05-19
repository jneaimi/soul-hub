<!--
projects-graph ADR-004 — Parent-rollup Gantt wrapper.

Renders a parent row that spans the date range of self + all descendants,
with an aggregate-progress chip. Click the parent row to expand and reveal
each descendant as its own sub-block containing the existing AdrGantt.

Expansion state is persisted in the same localStorage key that
/projects (the LIST view) uses — single source of truth so an operator
who expanded `soul-hub` in the list sees it expanded here too, and vice
versa (ADR-004 Assumption #4).

Falls back to a single AdrGantt for leaf projects (no descendants).
-->
<script lang="ts">
	import AdrGantt from './AdrGantt.svelte';

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
	}

	interface ProjectNode {
		slug: string;
		decisions?: DecisionRow[];
	}

	let {
		rootSlug,
		rootDecisions,
		descendants,
		onSelect,
	}: {
		rootSlug: string;
		rootDecisions: DecisionRow[];
		descendants: ProjectNode[];
		onSelect: (path: string) => void;
	} = $props();

	// Shared localStorage key (ADR-004 Assumption #4). Mirrors the LIST page.
	const EXPANDED_KEY = 'vault-projects-tree-expanded';
	let expanded = $state<Set<string>>(new Set());

	$effect(() => {
		try {
			const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EXPANDED_KEY) : null;
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) expanded = new Set(parsed.filter((x) => typeof x === 'string'));
			}
		} catch {
			// localStorage unavailable — start collapsed; LIST page would do the same.
		}
	});

	function toggle(slug: string) {
		const next = new Set(expanded);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		expanded = next;
		try {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			}
		} catch {
			// noop
		}
	}

	// Aggregate progress across self + descendants. shipped / total where
	// `total` counts non-superseded non-rejected decisions to match the
	// "active work" framing.
	const aggregate = $derived.by(() => {
		let shipped = 0;
		let total = 0;
		let earliest: string | null = null;
		let latest: string | null = null;
		const tally = (rows: DecisionRow[]) => {
			for (const d of rows) {
				if (d.status === 'rejected' || d.status === 'superseded') continue;
				total++;
				if (d.status === 'shipped') shipped++;
				const start = d.created;
				const end = d.shippedOn ?? d.acceptedOn ?? d.targetDate ?? null;
				if (start && (!earliest || start < earliest)) earliest = start;
				if (end && (!latest || end > latest)) latest = end;
			}
		};
		tally(rootDecisions);
		for (const child of descendants) tally(child.decisions ?? []);
		const pct = total > 0 ? Math.round((shipped / total) * 100) : 0;
		return { shipped, total, pct, earliest, latest };
	});

	const isOpen = $derived(expanded.has(rootSlug));
</script>

{#if descendants.length === 0}
	<!-- Leaf project — keep today's single Gantt verbatim. -->
	<AdrGantt decisions={rootDecisions} {onSelect} />
{:else}
	<div class="space-y-2">
		<!-- Parent row -->
		<div class="flex items-center gap-3 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5">
			<button
				type="button"
				onclick={() => toggle(rootSlug)}
				class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				aria-label={isOpen ? 'Collapse children' : 'Expand children'}
				aria-expanded={isOpen}
			>
				<span class="text-[11px] leading-none select-none">{isOpen ? '▼' : '▶'}</span>
			</button>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-xs font-semibold text-hub-text">{rootSlug}</span>
					<span class="text-[10px] uppercase tracking-wider text-hub-info">parent rollup</span>
					<span class="text-[11px] text-hub-dim">
						{descendants.length} child{descendants.length === 1 ? '' : 'ren'}
					</span>
				</div>
				<div class="flex items-center gap-3 mt-1 text-[11px]">
					<span class="text-hub-dim">
						<span class="text-hub-cta font-medium">{aggregate.shipped}</span>
						<span>/</span>
						<span class="text-hub-text">{aggregate.total}</span>
						shipped ({aggregate.pct}%)
					</span>
					{#if aggregate.earliest && aggregate.latest}
						<span class="text-hub-dim">
							{aggregate.earliest} → {aggregate.latest}
						</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- Root project's OWN Gantt — always visible regardless of toggle.
		     This matches today's per-project view: the operator's primary
		     concern is THIS project; descendants are zoom-out context. -->
		{#if rootDecisions.length > 0}
			<div class="px-3">
				<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-2">{rootSlug} (own)</div>
				<AdrGantt decisions={rootDecisions} {onSelect} />
			</div>
		{/if}

		<!-- Descendant sub-blocks — render only when parent expanded. -->
		{#if isOpen}
			{#each descendants as child (child.slug)}
				<div class="px-3 pl-6 border-l border-hub-border ml-3">
					<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-2 flex items-center justify-between">
						<a href="/projects/{child.slug}" class="hover:text-hub-text transition-colors font-mono">{child.slug}</a>
						<span>{(child.decisions ?? []).length} ADR{(child.decisions ?? []).length === 1 ? '' : 's'}</span>
					</div>
					{#if (child.decisions ?? []).length > 0}
						<AdrGantt decisions={child.decisions ?? []} {onSelect} />
					{:else}
						<div class="text-[11px] text-hub-dim italic py-2">no ADRs yet</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
{/if}
