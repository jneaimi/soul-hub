<!--
projects-graph ADR-016 — primary per-project ADR view.

Renders the project's decisions[] as a Sugiyama (layered DAG) network:
left-to-right by topological rank, one column per layer, one row per
sibling in the layer. blocked_by edges drive the layout. The vault's
frontmatter IS the layout source — no foreign axis (calendar) is
imposed.

Critical-path nodes + edges render in violet (reuses ADR-014's
computeCriticalPath() output verbatim). Cycle detection inherits from
the same utility; on cycle, a banner directs the operator to the
?view=gantt fallback (AdrGantt has a defensible same-row layout on
cycles).

Click an ADR pill → opens AdrDrawer via onSelect(path) — same callback
shape as AdrGantt, so the parent route's drawer state machine doesn't
care which view is rendering.
-->
<script lang="ts">
	import { computeCriticalPath } from '$lib/projects/critical-path.js';
	import { computeNetworkLayout } from '$lib/projects/dagre-layout.js';

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
		blockedBy?: string[];
	}

	let {
		decisions,
		onSelect,
	}: {
		decisions: DecisionRow[];
		onSelect: (path: string) => void;
	} = $props();

	let showInactive = $state(false);

	const visible = $derived(
		decisions
			.filter((d) => d.created)
			.filter((d) => showInactive || (d.status !== 'rejected' && d.status !== 'superseded')),
	);

	const dep = $derived.by(() =>
		computeCriticalPath(
			visible.map((d) => ({
				path: d.path,
				status: d.status,
				created: d.created,
				acceptedOn: d.acceptedOn,
				shippedOn: d.shippedOn,
				targetDate: d.targetDate,
				blockedBy: d.blockedBy ?? [],
			})),
		),
	);

	const layout = $derived.by(() =>
		dep.hasCycle ? null : computeNetworkLayout(visible, dep.edges),
	);

	function rowKey(d: { path: string }): string {
		const last = d.path.split('/').pop() ?? d.path;
		return last.replace(/\.md$/i, '');
	}

	/** Index decisions by row-key so the node-render loop can map back
	 *  from a `LaidOutNode.slug` to the original row's prose (title,
	 *  status, tooltip fields). */
	const rowsBySlug = $derived.by(() => {
		const m = new Map<string, DecisionRow>();
		for (const d of visible) m.set(rowKey(d), d);
		return m;
	});

	function statusFill(status: string): string {
		if (status === 'shipped') return 'var(--hub-cta, #34d399)';
		if (status === 'accepted') return 'var(--hub-info, #60a5fa)';
		if (status === 'proposed') return 'var(--hub-warning, #fbbf24)';
		if (status === 'rejected') return 'var(--hub-danger, #ef4444)';
		if (status === 'parked') return 'var(--hub-dim, #9ca3af)';
		if (status === 'superseded') return 'var(--hub-muted, #6b7280)';
		return 'var(--hub-card, #1f2937)';
	}

	function arrowColor(status: string | null): string {
		if (status === 'shipped') return 'var(--hub-cta, #34d399)';
		if (status === 'accepted') return 'var(--hub-info, #60a5fa)';
		if (status === 'proposed') return 'var(--hub-warning, #fbbf24)';
		if (status === 'parked') return 'var(--hub-dim, #9ca3af)';
		if (status === 'rejected') return 'var(--hub-danger, #ef4444)';
		if (status === 'superseded') return 'var(--hub-muted, #6b7280)';
		return 'var(--hub-muted, #6b7280)';
	}

	function shortLabel(d: DecisionRow): string {
		const m = d.title.match(/^ADR-\d+/);
		return m ? m[0] : d.title.split(/[—:]/)[0].trim().slice(0, 14);
	}

	function tooltip(d: DecisionRow): string {
		const parts = [d.title, '', `status: ${d.status}`, `created: ${d.created}`];
		if (d.acceptedOn) parts.push(`accepted: ${d.acceptedOn}`);
		if (d.shippedOn) parts.push(`shipped: ${d.shippedOn}`);
		if (d.targetDate) parts.push(`target: ${d.targetDate}`);
		if (d.falsifierDate) {
			const da = d.falsifierDaysAway;
			let suffix = '';
			if (da !== null) {
				if (da < 0) suffix = ` (${Math.abs(da)}d overdue)`;
				else if (da <= 7) suffix = ` (${da}d — urgent)`;
				else if (da <= 30) suffix = ` (${da}d — soon)`;
				else suffix = ` (${da}d — on track)`;
			}
			parts.push(`falsifier: ${d.falsifierDate}${suffix}`);
		}
		return parts.join('\n');
	}

	/** Render a single polyline as a smooth SVG path. dagre returns 3+
	 *  points (start, bend(s), end) — emit them as `M x y L x y …`. For
	 *  bends, a small `Q`/`C` curve would look slightly nicer but the
	 *  straight-line version reads cleanly at our node sizes and is
	 *  faster to layout (fewer floats per path). */
	function polyline(points: { x: number; y: number }[]): string {
		if (points.length === 0) return '';
		const [first, ...rest] = points;
		return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(' ');
	}

	const NODE_W = 130;
	const NODE_H = 32;
	const criticalCount = $derived(dep.criticalSlugs.size);
	const cycleCount = $derived(dep.hasCycle ? dep.cycleEdges.size : 0);
</script>

{#if visible.length === 0 && decisions.length > 0}
	<p class="text-xs text-hub-dim py-3">
		No ADRs with a <code class="font-mono">created</code> date yet.
	</p>
{:else if dep.hasCycle}
	<!-- Cycle detected — dagre Sugiyama assumes a DAG. AdrGantt has a
	     defensible fallback rendering (red dashed edges + flat layout) so
	     route the operator there until they resolve the cycle in
	     frontmatter. -->
	<div class="rounded-lg border border-hub-danger/40 bg-hub-danger/5 px-3 py-3 text-xs">
		<p class="text-hub-danger font-medium mb-1">Cycle detected in blocked_by graph</p>
		<p class="text-hub-dim">
			Network view needs a DAG. {cycleCount} edge{cycleCount === 1 ? '' : 's'} form a cycle.
			Open <a href="?view=gantt" class="text-hub-info hover:text-hub-text underline">Timeline view</a>
			to inspect the cyclical relationship, then resolve in the involved ADRs'
			<code class="font-mono">blocked_by</code> frontmatter.
		</p>
	</div>
{:else if layout && visible.length > 0}
	<div class="space-y-3">
		<!-- Legend + filter (mirrors AdrGantt's affordances) -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-hub-dim">
			<span class="inline-flex items-center gap-1.5">
				<span class="w-2.5 h-2.5 rounded bg-hub-warning/70"></span>proposed
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span class="w-2.5 h-2.5 rounded bg-hub-info/70"></span>accepted
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span class="w-2.5 h-2.5 rounded bg-hub-cta/70"></span>shipped
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span class="w-2.5 h-2.5 rounded bg-hub-dim/40"></span>parked
			</span>
			{#if showInactive}
				<span class="inline-flex items-center gap-1.5">
					<span class="w-2.5 h-2.5 rounded bg-hub-muted/30"></span>superseded
				</span>
				<span class="inline-flex items-center gap-1.5">
					<span class="w-2.5 h-2.5 rounded bg-hub-danger/40"></span>rejected
				</span>
			{/if}
			{#if layout.edges.length > 0}
				<span class="inline-flex items-center gap-1.5" title="Dependency edges — blocker → dependent">
					<svg viewBox="0 0 14 6" class="w-3.5 h-1.5" aria-hidden="true">
						<path d="M 0 3 L 12 3" stroke="currentColor" stroke-width="1.5" fill="none" />
						<path d="M 9 0.5 L 12 3 L 9 5.5" stroke="currentColor" stroke-width="1.5" fill="none" />
					</svg>
					{layout.edges.length} edge{layout.edges.length === 1 ? '' : 's'}
				</span>
				{#if criticalCount > 0}
					<span class="inline-flex items-center gap-1.5" title="Critical path — longest chain ending at an unshipped ADR">
						<span class="w-2.5 h-2.5 rounded" style:background-color="#a78bfa"></span>
						critical path ({criticalCount})
					</span>
				{/if}
			{/if}
			<span class="text-hub-dim">· {layout.ranks} rank{layout.ranks === 1 ? '' : 's'} · {visible.length} ADR{visible.length === 1 ? '' : 's'}</span>
			<button
				class="ml-auto text-[11px] text-hub-info hover:text-hub-text cursor-pointer"
				onclick={() => (showInactive = !showInactive)}
			>
				{showInactive ? 'Hide' : 'Show'} rejected / superseded
			</button>
		</div>

		<!-- Network canvas. Scrolls horizontally when wider than container;
		     dagre's bounds already include a margin so no extra padding. -->
		<div class="border border-hub-border rounded-lg bg-hub-card/30 overflow-auto">
			<svg
				viewBox="0 0 {layout.bounds.width} {layout.bounds.height}"
				style:width="{layout.bounds.width}px"
				style:height="{layout.bounds.height}px"
				style:max-width="100%"
				class="block"
				role="img"
				aria-label="ADR dependency network — {visible.length} ADRs, {layout.edges.length} edges, {criticalCount} on critical path"
			>
				<defs>
					<marker
						id="adr-network-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						markerUnits="strokeWidth"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
					</marker>
				</defs>

				<!-- Edges underneath nodes -->
				{#each layout.edges as e (e.edge.blocker + '→' + e.edge.dependent)}
					{@const ekey = `${e.edge.blocker}→${e.edge.dependent}`}
					{@const onCritical =
						dep.criticalSlugs.has(e.edge.blocker) && dep.criticalSlugs.has(e.edge.dependent)}
					{@const stroke = onCritical ? '#a78bfa' : arrowColor(e.edge.blockerStatus)}
					<path
						d={polyline(e.points)}
						fill="none"
						stroke={stroke}
						stroke-width={onCritical ? 2.25 : 1.4}
						opacity={onCritical ? 0.95 : 0.75}
						marker-end="url(#adr-network-arrow)"
						style:color={stroke}
					/>
					{void ekey}
				{/each}

				<!-- Nodes -->
				{#each layout.nodes as n (n.slug)}
					{@const row = rowsBySlug.get(n.slug)}
					{#if row}
						{@const isCritical = dep.criticalSlugs.has(n.slug)}
						<g
							class="adr-network-node"
							class:adr-network-critical={isCritical}
							transform="translate({n.x - NODE_W / 2}, {n.y - NODE_H / 2})"
							onclick={() => onSelect(row.path)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onSelect(row.path);
								}
							}}
							role="button"
							tabindex="0"
							aria-current={isCritical ? 'true' : undefined}
							aria-label={shortLabel(row) + ' — ' + row.status}
						>
							<title>{tooltip(row)}</title>
							<rect
								width={NODE_W}
								height={NODE_H}
								rx="6"
								ry="6"
								fill={statusFill(row.status)}
								fill-opacity="0.7"
								stroke-width={row.dateInferred ? 1 : 0}
								stroke-dasharray={row.dateInferred ? '3 2' : undefined}
								stroke="var(--hub-text, #e5e7eb)"
							/>
							<text
								x={NODE_W / 2}
								y={NODE_H / 2 + 1}
								text-anchor="middle"
								dominant-baseline="middle"
								class="adr-network-label"
								fill="var(--hub-bg, #0b0e14)"
							>{shortLabel(row)}</text>
						</g>
					{/if}
				{/each}
			</svg>
		</div>

		<!-- Footer summary -->
		<div class="text-[11px] text-hub-dim flex flex-wrap items-center gap-x-3 gap-y-1">
			<span>{visible.length} ADR{visible.length === 1 ? '' : 's'}</span>
			{#if layout.edges.length > 0}
				<span>· {layout.edges.length} dependency edge{layout.edges.length === 1 ? '' : 's'}</span>
			{/if}
			{#if criticalCount > 0}
				<span title="Longest dependency chain ending at an unshipped ADR">
					· critical path: {criticalCount} ADR{criticalCount === 1 ? '' : 's'}
				</span>
			{/if}
			<span class="ml-auto text-hub-dim/70">
				layout: dagre Sugiyama · left → right
			</span>
		</div>
	</div>
{/if}

<style>
	:global(.adr-network-node) {
		cursor: pointer;
	}
	:global(.adr-network-node:hover rect) {
		fill-opacity: 1;
	}
	:global(.adr-network-node:focus-visible) {
		outline: none;
	}
	:global(.adr-network-node:focus-visible rect) {
		outline: 2px solid var(--hub-cta, #34d399);
		outline-offset: 2px;
	}
	:global(.adr-network-critical rect) {
		outline: 2px solid #a78bfa;
		outline-offset: 1.5px;
	}
	:global(.adr-network-label) {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		font-weight: 600;
		pointer-events: none;
		user-select: none;
	}
</style>
