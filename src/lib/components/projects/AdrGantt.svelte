<script lang="ts">
	/** Phase 3c — ADR timeline (Gantt) for one project.
	 *
	 *  Each row is one decision. The bar runs from `created` to the latest
	 *  meaningful date the ADR has reached (`shipped_on` → `accepted_on` →
	 *  `target_date` → today). The bar colour matches the ADR's current status.
	 *
	 *  Bars carrying `date_inferred: true` render with a dashed border — those
	 *  dates were derived from git-history bulk commits during the Phase 3c-prep
	 *  backfill, so they are honest about being approximate. Operators can edit
	 *  them via the drawer to flip the flag off.
	 *
	 *  Click a bar → opens the same AdrDrawer the rest of the project page uses.
	 *
	 *  projects-graph ADR-014 — when ADR rows carry `blockedBy: string[]`,
	 *  an SVG overlay renders Bezier arrows from each blocker's bar-end to
	 *  the dependent's bar-start. Color matches the blocker's status so the
	 *  reader sees at a glance whether the dependency is satisfied. The
	 *  longest dependency chain ending at an unshipped ADR is highlighted
	 *  in violet (critical path). Cycles render in red with a legend
	 *  warning — they're a data bug worth fixing. */

	import { computeCriticalPath, type DepEdge } from '$lib/projects/critical-path.js';

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
		/** projects-graph ADR-014 — raw wikilink strings as returned by
		 *  `/api/vault/projects` (see `+server.ts` `blockedBy` field).
		 *  Optional so existing call-sites that don't pass it still type-check. */
		blockedBy?: string[];
	}

	let {
		decisions,
		onSelect,
	}: {
		decisions: DecisionRow[];
		onSelect: (path: string) => void;
	} = $props();

	const TODAY_ISO = new Date().toISOString().slice(0, 10);
	const TODAY_MS = Date.parse(TODAY_ISO);
	const MIN_BAR_PCT = 0.5;

	// Showing rejected/superseded by default makes the chart noisy; let the
	// operator toggle them in. Parked stays visible because it's still an open
	// commitment to revisit.
	let showInactive = $state(false);

	function endIso(d: DecisionRow): string {
		if (d.shippedOn) return d.shippedOn;
		if (d.acceptedOn) return d.acceptedOn;
		if (d.targetDate) return d.targetDate;
		return TODAY_ISO;
	}

	const visible = $derived(
		decisions
			.filter((d) => d.created)
			.filter((d) => showInactive || (d.status !== 'rejected' && d.status !== 'superseded'))
			.slice()
			.sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '')),
	);

	const range = $derived.by(() => {
		if (visible.length === 0) return null;
		const starts = visible.map((d) => Date.parse(d.created!));
		const ends = visible.map((d) => Date.parse(endIso(d)));
		const targets = visible.filter((d) => d.targetDate).map((d) => Date.parse(d.targetDate!));
		const falsifiers = visible
			.filter((d) => d.falsifierDate)
			.map((d) => Date.parse(d.falsifierDate!));
		const startMs = Math.min(...starts);
		const endMs = Math.max(TODAY_MS, ...ends, ...targets, ...falsifiers);
		const pad = Math.max((endMs - startMs) * 0.03, 86_400_000); // ≥1 day
		return { startMs: startMs - pad, endMs: endMs + pad };
	});

	function pct(ms: number): number {
		if (!range) return 0;
		return ((ms - range.startMs) / (range.endMs - range.startMs)) * 100;
	}

	/** Adaptive axis ticks. Cadence depends on the visible span so labels
	 *  never collapse on top of each other:
	 *  - ≤ 60 days  → weekly (every Monday)
	 *  - ≤ 180 days → fortnightly (every other Monday)
	 *  - > 180 days → monthly (1st of each month)
	 *  Label format also adapts (DD Mon vs Mon 'YY). */
	const axisTicks = $derived.by(() => {
		if (!range) return [];
		const out: { leftPct: number; label: string; major: boolean }[] = [];
		const spanDays = (range.endMs - range.startMs) / 86_400_000;
		const start = new Date(range.startMs);

		if (spanDays > 180) {
			const cur = new Date(start.getFullYear(), start.getMonth(), 1);
			if (cur.getTime() < range.startMs) cur.setMonth(cur.getMonth() + 1);
			while (cur.getTime() <= range.endMs) {
				out.push({
					leftPct: pct(cur.getTime()),
					label: cur.toLocaleDateString('en', { month: 'short', year: '2-digit' }),
					major: cur.getMonth() === 0,
				});
				cur.setMonth(cur.getMonth() + 1);
			}
		} else {
			// Week-aligned ticks. Snap to nearest Monday on/after start.
			const stride = spanDays > 60 ? 14 : 7;
			const cur = new Date(start);
			const dow = cur.getDay(); // 0=Sun, 1=Mon, …
			const daysToMonday = (8 - dow) % 7 || 7; // always advance at least 1 day if already Mon at midnight
			cur.setDate(cur.getDate() + daysToMonday);
			cur.setHours(0, 0, 0, 0);
			while (cur.getTime() <= range.endMs) {
				out.push({
					leftPct: pct(cur.getTime()),
					label: cur.toLocaleDateString('en', { day: 'numeric', month: 'short' }),
					major: cur.getDate() <= 7, // first Mon of month gets emphasized
				});
				cur.setDate(cur.getDate() + stride);
			}
		}
		return out;
	});

	const todayPct = $derived(range ? pct(TODAY_MS) : 0);
	const todayLabel = $derived(
		new Date(TODAY_MS).toLocaleDateString('en', { day: 'numeric', month: 'short' }),
	);

	function statusFill(status: string): string {
		if (status === 'shipped') return 'bg-hub-cta/70 group-hover:bg-hub-cta';
		if (status === 'accepted') return 'bg-hub-info/70 group-hover:bg-hub-info';
		if (status === 'proposed') return 'bg-hub-warning/70 group-hover:bg-hub-warning';
		if (status === 'rejected') return 'bg-hub-danger/40 group-hover:bg-hub-danger/60';
		if (status === 'parked') return 'bg-hub-dim/40 group-hover:bg-hub-dim/60';
		if (status === 'superseded') return 'bg-hub-muted/30 group-hover:bg-hub-muted/50';
		return 'bg-hub-card group-hover:bg-hub-card/80';
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
				// Mirror the urgency buckets from falsifierFill() so the
				// tooltip explains the diamond colour the reader is seeing.
				if (da < 0) suffix = ` (${Math.abs(da)}d overdue — red diamond)`;
				else if (da <= 7) suffix = ` (${da}d — urgent, red diamond)`;
				else if (da <= 30) suffix = ` (${da}d — review soon, amber diamond)`;
				else suffix = ` (${da}d — on track, muted diamond)`;
			}
			parts.push(`falsifier: ${d.falsifierDate}${suffix}`);
		}
		if (d.dateInferred) parts.push('', 'dates inferred from git history');
		return parts.join('\n');
	}

	/** Falsifier diamond colour. Red if overdue or due within a week; amber
	 *  if within a month; muted otherwise. Same buckets the project detail
	 *  page uses for its falsifier badge. */
	function falsifierFill(daysAway: number | null): string {
		if (daysAway === null) return 'bg-hub-muted/60';
		if (daysAway <= 7) return 'bg-hub-danger';
		if (daysAway <= 30) return 'bg-hub-warning';
		return 'bg-hub-muted/60';
	}

	const counts = $derived.by(() => {
		const c = { shipped: 0, accepted: 0, proposed: 0, parked: 0, rejected: 0, superseded: 0 };
		for (const d of visible) {
			if (d.status in c) c[d.status as keyof typeof c]++;
		}
		return c;
	});

	const inferredCount = $derived(visible.filter((d) => d.dateInferred).length);
	const falsifierCount = $derived(visible.filter((d) => d.falsifierDate).length);

	/** ADRs that are open (proposed/accepted) but carry neither a
	 *  `target_date` nor a `falsifier_date` — meaning the chart has no
	 *  forward signal for when they should ship or be reviewed. These
	 *  are the ones quietly losing momentum; the tray surfaces them so
	 *  the operator can schedule them. */
	const unscheduled = $derived(
		decisions.filter(
			(d) =>
				(d.status === 'proposed' || d.status === 'accepted') &&
				!d.targetDate &&
				!d.falsifierDate,
		),
	);

	/** projects-graph ADR-014 — derive critical-path + edge list over the
	 *  visible rows (so filter-toggled rejected/superseded don't pollute
	 *  the graph). `rowKey` mirrors the helper inside the utility — filename
	 *  without `.md`. The `rowIndex` map lets the SVG overlay translate a
	 *  row key into a Y-coordinate without re-walking `visible`. */
	function rowKey(d: { path: string }): string {
		const last = d.path.split('/').pop() ?? d.path;
		return last.replace(/\.md$/i, '');
	}

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

	const rowIndex = $derived.by(() => {
		const m = new Map<string, number>();
		visible.forEach((d, i) => m.set(rowKey(d), i));
		return m;
	});

	/** Visible intra-project edges that have both endpoints in the current
	 *  set. SVG overlay iterates this; external + missing-endpoint edges
	 *  are not rendered in v1 (deferred to a follow-up). */
	const renderEdges = $derived(
		dep.edges.filter((e) => !e.external && rowIndex.has(e.blocker) && rowIndex.has(e.dependent)),
	);

	const cycleCount = $derived(dep.hasCycle ? dep.cycleEdges.size : 0);
	const criticalCount = $derived(dep.criticalSlugs.size);

	/** SVG arrow color per blocker status. Mirrors the `statusFill()` bar
	 *  colors but uses the solid token (no opacity) so arrows read clearly
	 *  against the chart background. Critical-path edges override this with
	 *  the violet accent in the template. */
	function arrowColor(status: string | null): string {
		if (status === 'shipped') return 'var(--hub-cta, #34d399)';
		if (status === 'accepted') return 'var(--hub-info, #60a5fa)';
		if (status === 'proposed') return 'var(--hub-warning, #fbbf24)';
		if (status === 'parked') return 'var(--hub-dim, #9ca3af)';
		if (status === 'rejected') return 'var(--hub-danger, #ef4444)';
		if (status === 'superseded') return 'var(--hub-muted, #6b7280)';
		return 'var(--hub-muted, #6b7280)';
	}

	/** Bezier path connecting (xStart, yStart) to (xEnd, yEnd) in the
	 *  100-wide × N-tall viewBox. Control-point offset scales with the
	 *  horizontal gap so dense graphs read clearly. */
	function bezierPath(
		xStart: number,
		yStart: number,
		xEnd: number,
		yEnd: number,
	): string {
		const dx = Math.max(2, Math.abs(xEnd - xStart) * 0.35);
		// Same-row self-edge would render as a flat line; nudge it into a
		// small arc above the row. Rare in practice (no live data hits this),
		// but cheap to handle.
		if (Math.abs(yStart - yEnd) < 0.01) {
			const yArc = yStart - 0.4;
			return `M ${xStart} ${yStart} C ${xStart + dx} ${yArc}, ${xEnd - dx} ${yArc}, ${xEnd} ${yEnd}`;
		}
		return `M ${xStart} ${yStart} C ${xStart + dx} ${yStart}, ${xEnd - dx} ${yEnd}, ${xEnd} ${yEnd}`;
	}
</script>

{#if visible.length === 0 && decisions.length > 0}
	<p class="text-xs text-hub-dim py-3">No ADRs with a <code class="font-mono">created</code> date yet.</p>
{:else if visible.length > 0 && range}
	<div class="space-y-3">
		<!-- Legend + filter -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-hub-dim">
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-warning/70"></span>proposed</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-info/70"></span>accepted</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-cta/70"></span>shipped</span>
			<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-dim/40"></span>parked</span>
			{#if showInactive}
				<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-muted/30"></span>superseded</span>
				<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-hub-danger/40"></span>rejected</span>
			{/if}
			{#if inferredCount > 0}
				<span class="inline-flex items-center gap-1.5">
					<span class="w-2.5 h-2.5 rounded border border-dashed border-hub-muted"></span>
					inferred ({inferredCount})
				</span>
			{/if}
			{#if falsifierCount > 0}
				<span class="inline-flex items-center gap-1.5" title="Falsifier ≤7 days — urgent review">
					<span class="w-2 h-2 rotate-45 bg-hub-danger"></span>
					≤7d
				</span>
				<span class="inline-flex items-center gap-1.5" title="Falsifier ≤30 days — review soon">
					<span class="w-2 h-2 rotate-45 bg-hub-warning"></span>
					≤30d
				</span>
				<span class="inline-flex items-center gap-1.5" title="Falsifier >30 days — on track">
					<span class="w-2 h-2 rotate-45 bg-hub-muted/60"></span>
					&gt;30d
				</span>
				<span class="text-hub-dim">· falsifier ({falsifierCount})</span>
			{/if}
			<!-- projects-graph ADR-014 — dependency-arrow + critical-path legend.
			     Only rendered when there's at least one edge to talk about so
			     unblocked projects don't get extra chrome. -->
			{#if renderEdges.length > 0}
				<span class="inline-flex items-center gap-1.5" title="Dependency arrow — blocker → dependent, color matches blocker status">
					<svg viewBox="0 0 14 6" class="w-3.5 h-1.5" aria-hidden="true">
						<path d="M 0 3 L 12 3" stroke="currentColor" stroke-width="1.5" fill="none" />
						<path d="M 9 0.5 L 12 3 L 9 5.5" stroke="currentColor" stroke-width="1.5" fill="none" />
					</svg>
					dep arrow ({renderEdges.length})
				</span>
				{#if criticalCount > 0}
					<span class="inline-flex items-center gap-1.5" title="Critical path — longest dependency chain to an unshipped ADR">
						<span class="w-2.5 h-2.5 rounded" style:background-color="#a78bfa"></span>
						critical path ({criticalCount})
					</span>
				{/if}
				{#if cycleCount > 0}
					<span class="inline-flex items-center gap-1.5 text-hub-danger" title="Cycle detected — A blocks B blocks A (or longer). Resolve in the blocker frontmatter.">
						<span class="w-2.5 h-2.5 rounded border-2 border-hub-danger"></span>
						cycle ({cycleCount})
					</span>
				{/if}
			{/if}
			<button
				class="ml-auto text-[11px] text-hub-info hover:text-hub-text cursor-pointer"
				onclick={() => (showInactive = !showInactive)}
			>
				{showInactive ? 'Hide' : 'Show'} rejected / superseded
			</button>
		</div>

		<!-- Unscheduled tray — open ADRs with no target_date and no falsifier_date.
		     These don't show on the timeline because they have no forward signal;
		     surfacing them as chips here keeps them visible so they don't drift. -->
		{#if unscheduled.length > 0}
			<div class="rounded-lg border border-hub-dim/40 bg-hub-card/30 px-3 py-2">
				<div class="flex items-baseline justify-between mb-1.5">
					<span class="text-[11px] font-medium text-hub-muted">
						Unscheduled
						<span class="text-hub-dim font-normal">— no target or falsifier date</span>
					</span>
					<span class="text-[10px] text-hub-dim">{unscheduled.length}</span>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each unscheduled as d (d.path)}
						<button
							type="button"
							class="group inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono border border-hub-border bg-hub-bg/40 hover:border-hub-cta/40 hover:bg-hub-card transition-colors cursor-pointer"
							onclick={() => onSelect(d.path)}
							title={tooltip(d)}
						>
							<span
								class="w-1.5 h-1.5 rounded-full {d.status === 'proposed' ? 'bg-hub-warning' : 'bg-hub-info'}"
								aria-hidden="true"
							></span>
							<span class="text-hub-text group-hover:text-hub-cta">{shortLabel(d)}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Chart -->
		<div class="border border-hub-border rounded-lg bg-hub-card/30 overflow-hidden">
			<!-- Time axis -->
			<div class="relative h-9 border-b border-hub-border bg-hub-card/40 ml-[140px]">
				{#each axisTicks as tick}
					<div
						class="absolute top-0 h-full border-l {tick.major ? 'border-hub-border' : 'border-hub-border/50'}"
						style:left="{tick.leftPct}%"
					>
						<span
							class="absolute top-1.5 left-1.5 text-[10px] whitespace-nowrap {tick.major ? 'text-hub-muted font-medium' : 'text-hub-dim'}"
						>
							{tick.label}
						</span>
					</div>
				{/each}
				<!-- Today marker + label -->
				<div
					class="absolute top-0 h-full border-l-2 border-hub-cta/60"
					style:left="{todayPct}%"
				>
					<span
						class="absolute top-1.5 left-1.5 px-1 rounded text-[10px] font-medium text-hub-cta bg-hub-bg/80 whitespace-nowrap"
					>
						Today · {todayLabel}
					</span>
				</div>
			</div>

			<!-- Rows -->
			<div class="relative">
				<div class="divide-y divide-hub-border/40">
					{#each visible as d (d.path)}
						{@const startPct = pct(Date.parse(d.created!))}
						{@const endPct = pct(Date.parse(endIso(d)))}
						{@const widthPct = Math.max(endPct - startPct, MIN_BAR_PCT)}
						{@const targetPct = d.targetDate ? pct(Date.parse(d.targetDate)) : null}
						{@const falsifierPct = d.falsifierDate ? pct(Date.parse(d.falsifierDate)) : null}
						{@const isOpen = d.status === 'proposed' || d.status === 'accepted'}
						{@const isCritical = dep.criticalSlugs.has(rowKey(d))}
						{@const forecastEndPct = isOpen
							? Math.max(
									endPct,
									targetPct ?? -Infinity,
									// For accepted ADRs only, extend to falsifier as a fallback
									// when there's no target_date — falsifier is the implicit
									// review deadline. Proposed ADRs keep target_date-only
									// behaviour so the dashed bar means "scheduled to ship".
									d.status === 'accepted' && !d.targetDate ? falsifierPct ?? -Infinity : -Infinity,
								)
							: endPct}
						<button
							type="button"
							class="group w-full flex items-stretch h-7 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
							onclick={() => onSelect(d.path)}
							title={tooltip(d)}
							aria-current={isCritical ? 'true' : undefined}
						>
							<!-- Label gutter -->
							<div class="w-[140px] flex-shrink-0 flex items-center px-2 border-r border-hub-border/40">
								<span class="text-[11px] font-mono text-hub-text truncate flex items-center gap-1">
									{#if isCritical}<span class="adr-gantt-critical-dot" title="On the critical path" aria-hidden="true"></span>{/if}
									{shortLabel(d)}
								</span>
							</div>
							<!-- Bar lane -->
							<div class="flex-1 relative">
								<!-- Bar -->
								<div
									class="absolute top-1.5 bottom-1.5 rounded {statusFill(d.status)} transition-colors {d.dateInferred ? 'border border-dashed border-hub-text/30' : ''} {isCritical ? 'adr-gantt-critical-bar' : ''}"
									style:left="{startPct}%"
									style:width="{widthPct}%"
								></div>
								<!-- Forecast extension for open ADRs (proposed → target_date,
								     accepted → target_date OR falsifier_date if no target). -->
								{#if isOpen && forecastEndPct > endPct}
									<div
										class="absolute top-2.5 bottom-2.5 rounded border border-dashed {d.status === 'proposed' ? 'border-hub-warning/60' : 'border-hub-info/60'}"
										style:left="{endPct}%"
										style:width="{Math.max(forecastEndPct - endPct, MIN_BAR_PCT)}%"
										title="Forecast → {d.targetDate ?? d.falsifierDate}"
									></div>
								{/if}
								<!-- Falsifier diamond — rendered on every ADR that carries
								     a falsifier_date, regardless of status. Click bubbles
								     to the row button (drawer opens via onSelect). -->
								{#if falsifierPct !== null}
									<span
										class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 {falsifierFill(d.falsifierDaysAway)} border border-hub-bg shadow-sm pointer-events-none"
										style:left="{falsifierPct}%"
										aria-hidden="true"
									></span>
								{/if}
							</div>
						</button>
					{/each}
				</div>

				<!-- projects-graph ADR-014 — dependency-arrow SVG overlay.
				     Positioned absolutely over the bar-lane region (140px label
				     gutter offset matches the row layout above). `pointer-events:
				     none` so bar clicks still open the drawer through the overlay.
				     viewBox is 100-wide × {visible.length}-tall so X is a percent
				     (matches the bars' `style:left`) and Y is rowIndex (row center
				     at index+0.5). `preserveAspectRatio="none"` lets X stretch
				     independently of Y; strokes stay 1.5px via vector-effect. -->
				{#if renderEdges.length > 0}
					<svg
						class="absolute top-0 bottom-0 pointer-events-none"
						style:left="140px"
						style:right="0"
						style:width="calc(100% - 140px)"
						viewBox="0 0 100 {visible.length}"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<defs>
							<marker
								id="adr-gantt-arrow-default"
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								markerUnits="strokeWidth"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
							</marker>
							<marker
								id="adr-gantt-arrow-fallback"
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								markerUnits="strokeWidth"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
							</marker>
						</defs>
						{#each renderEdges as e (e.blocker + '→' + e.dependent)}
							{@const bIdx = rowIndex.get(e.blocker) ?? 0}
							{@const dIdx = rowIndex.get(e.dependent) ?? 0}
							{@const bRow = visible[bIdx]}
							{@const dRow = visible[dIdx]}
							{@const bStart = bRow ? pct(Date.parse(bRow.created!)) : 0}
							{@const bEnd = bRow ? pct(Date.parse(endIso(bRow))) : 0}
							{@const dStart = dRow ? pct(Date.parse(dRow.created!)) : 0}
							{@const xStart = Math.max(bStart + MIN_BAR_PCT, bEnd)}
							{@const xEnd = dStart}
							{@const yStart = bIdx + 0.5}
							{@const yEnd = dIdx + 0.5}
							{@const isCycle = dep.cycleEdges.has(`${e.blocker}→${e.dependent}`)}
							{@const onCritical = dep.criticalSlugs.has(e.blocker) && dep.criticalSlugs.has(e.dependent)}
							<path
								d={bezierPath(xStart, yStart, xEnd, yEnd)}
								fill="none"
								stroke={isCycle ? '#ef4444' : onCritical ? '#a78bfa' : arrowColor(e.blockerStatus)}
								stroke-width={onCritical ? 2 : isCycle ? 2 : 1.25}
								stroke-dasharray={isCycle ? '3 2' : undefined}
								opacity={onCritical ? 0.95 : 0.7}
								vector-effect="non-scaling-stroke"
								marker-end="url(#adr-gantt-arrow-default)"
								style:color={isCycle ? '#ef4444' : onCritical ? '#a78bfa' : arrowColor(e.blockerStatus)}
							/>
						{/each}
					</svg>
				{/if}
			</div>

			<!-- Footer summary -->
			<div class="px-3 py-2 border-t border-hub-border/40 bg-hub-card/40 text-[11px] text-hub-dim flex flex-wrap items-center gap-x-3 gap-y-1">
				<span>{visible.length} ADR{visible.length === 1 ? '' : 's'}</span>
				{#if counts.shipped > 0}<span>· {counts.shipped} shipped</span>{/if}
				{#if counts.accepted > 0}<span>· {counts.accepted} accepted</span>{/if}
				{#if counts.proposed > 0}<span>· {counts.proposed} proposed</span>{/if}
				{#if counts.parked > 0}<span>· {counts.parked} parked</span>{/if}
				{#if showInactive && counts.rejected > 0}<span>· {counts.rejected} rejected</span>{/if}
				{#if showInactive && counts.superseded > 0}<span>· {counts.superseded} superseded</span>{/if}
				{#if criticalCount > 0}
					<span class="text-hub-dim" title="Longest dependency chain ending at an unshipped ADR">
						· critical path: {criticalCount} ADR{criticalCount === 1 ? '' : 's'}
					</span>
				{/if}
				{#if cycleCount > 0}
					<span class="text-hub-danger" title="Resolve via the blocker frontmatter on the involved ADRs">
						· cycle: {cycleCount} edge{cycleCount === 1 ? '' : 's'}
					</span>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	/* projects-graph ADR-014 — critical-path highlight.
	   Violet rim on bars + a small leading dot in the gutter so the chain is
	   readable at a glance, including in monochrome screenshots. Kept as a
	   `:global` block so the dynamic class (`adr-gantt-critical-bar`) on the
	   absolutely-positioned bar div survives Svelte's scoping. */
	:global(.adr-gantt-critical-bar) {
		box-shadow: 0 0 0 1.5px #a78bfa inset;
	}
	:global(.adr-gantt-critical-dot) {
		display: inline-block;
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 9999px;
		background-color: #a78bfa;
	}
</style>
