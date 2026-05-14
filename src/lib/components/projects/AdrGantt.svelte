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
	 *  Click a bar → opens the same AdrDrawer the rest of the project page uses. */

	interface DecisionRow {
		path: string;
		title: string;
		status: string;
		created: string | null;
		acceptedOn: string | null;
		shippedOn: string | null;
		targetDate: string | null;
		dateInferred: boolean;
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
		const startMs = Math.min(...starts);
		const endMs = Math.max(TODAY_MS, ...ends, ...targets);
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
		if (d.dateInferred) parts.push('', 'dates inferred from git history');
		return parts.join('\n');
	}

	const counts = $derived.by(() => {
		const c = { shipped: 0, accepted: 0, proposed: 0, parked: 0, rejected: 0, superseded: 0 };
		for (const d of visible) {
			if (d.status in c) c[d.status as keyof typeof c]++;
		}
		return c;
	});

	const inferredCount = $derived(visible.filter((d) => d.dateInferred).length);
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
			<button
				class="ml-auto text-[11px] text-hub-info hover:text-hub-text cursor-pointer"
				onclick={() => (showInactive = !showInactive)}
			>
				{showInactive ? 'Hide' : 'Show'} rejected / superseded
			</button>
		</div>

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
			<div class="divide-y divide-hub-border/40">
				{#each visible as d (d.path)}
					{@const startPct = pct(Date.parse(d.created!))}
					{@const endPct = pct(Date.parse(endIso(d)))}
					{@const widthPct = Math.max(endPct - startPct, MIN_BAR_PCT)}
					{@const targetPct = d.targetDate ? pct(Date.parse(d.targetDate)) : null}
					<button
						type="button"
						class="group w-full flex items-stretch h-7 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
						onclick={() => onSelect(d.path)}
						title={tooltip(d)}
					>
						<!-- Label gutter -->
						<div class="w-[140px] flex-shrink-0 flex items-center px-2 border-r border-hub-border/40">
							<span class="text-[11px] font-mono text-hub-text truncate">
								{shortLabel(d)}
							</span>
						</div>
						<!-- Bar lane -->
						<div class="flex-1 relative">
							<!-- Bar -->
							<div
								class="absolute top-1.5 bottom-1.5 rounded {statusFill(d.status)} transition-colors {d.dateInferred ? 'border border-dashed border-hub-text/30' : ''}"
								style:left="{startPct}%"
								style:width="{widthPct}%"
							></div>
							<!-- Forecast extension to target_date for proposed ADRs -->
							{#if d.status === 'proposed' && targetPct !== null && targetPct > endPct}
								<div
									class="absolute top-2.5 bottom-2.5 rounded border border-dashed border-hub-warning/60"
									style:left="{endPct}%"
									style:width="{Math.max(targetPct - endPct, MIN_BAR_PCT)}%"
									title="Forecast → {d.targetDate}"
								></div>
							{/if}
						</div>
					</button>
				{/each}
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
			</div>
		</div>
	</div>
{/if}
