/** Composite health score 0-100. Higher = cleaner.
 *
 *  Each issue category contributes a capped penalty so a single noisy
 *  category can't drive the score to 0 while everything else is fine.
 *  Caps roughly match "this is bad enough to care, but not the whole
 *  picture": 20 points max for orphans (high signal of structural
 *  drift), 15 for status contradictions (need human attention), 10
 *  each for unresolved/stale-inbox/governance. Total max penalty 75 →
 *  worst possible = 25; we don't return 0 because something is always
 *  recoverable. */

import type { HygieneTotals } from './types.js';

interface Penalty {
	perItem: number;
	max: number;
}

const PENALTIES: Record<keyof HygieneTotals, Penalty | null> = {
	indexed: null,
	orphans: { perItem: 2, max: 20 },
	unresolved: { perItem: 1, max: 10 },
	staleInbox: { perItem: 1, max: 10 },
	statusContradictions: { perItem: 3, max: 15 },
	governanceViolations: { perItem: 0.5, max: 20 },
};

export function computeHealthScore(totals: HygieneTotals): number {
	let penalty = 0;
	for (const key of Object.keys(PENALTIES) as (keyof HygieneTotals)[]) {
		const config = PENALTIES[key];
		if (!config) continue;
		const count = totals[key];
		penalty += Math.min(count * config.perItem, config.max);
	}
	const score = 100 - penalty;
	return Math.max(0, Math.round(score));
}
