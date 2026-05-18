/** Heartbeat-driven hygiene tick.
 *
 *  Called from `src/lib/channels/whatsapp/heartbeat.ts` every 30 min.
 *  Independent of the LLM heartbeat path — we run regardless of active
 *  hours / mute, because keeper's auto-fixes and any escalations are
 *  silent unless something is actually wrong.
 *
 *  Flow:
 *    1. Build report via getHygieneReport()
 *    2. Compare totals to threshold; if not actionable → return early
 *    3. Hash the actionable issue set; if same as last dispatch and
 *       cooldown not elapsed → return early (avoid hammering keeper
 *       on a long-lived issue)
 *    4. Dispatch keeper with the report payload as task context
 *    5. Update in-memory state with new hash + timestamp
 *
 *  In-memory state resets on PM2 restart. That's acceptable: a
 *  restart re-firing keeper once on the same issue costs ~$0.01 and
 *  surfaces the issue if the operator just deployed.
 */

import { dispatchAgent } from '../agents/dispatch/index.js';
import { getHygieneReport } from './report.js';
import { DEFAULT_HYGIENE_THRESHOLD } from './types.js';
import { emitVaultHygieneEscalations } from './vault-escalator.js';
import type { HygieneReport, HygieneThreshold } from './types.js';

/** Time-based cooldown only. We previously tried hash-based "same issue
 *  set" detection, but keeper's auto-fixes mutate the issue list during
 *  its run — the next tick sees a slightly different report and the
 *  hash no longer matches, defeating the cooldown. Plain time wins:
 *  one dispatch per cooldown window, regardless of which issues drift
 *  in or out. 30 min matches the heartbeat cadence so we run roughly
 *  once per tick when there's actionable work. */
const COOLDOWN_MS = 30 * 60 * 1000;
const KEEPER_AGENT_ID = 'keeper';

interface DispatchState {
	lastDispatchAt: number;
}

let state: DispatchState | null = null;
/** In-flight guard. Without this, two concurrent ticks (e.g. heartbeat
 *  fires at 30:00 while a manual `/api/vault/hygiene/tick` is still
 *  running keeper) would both dispatch — the cooldown state isn't set
 *  until the first dispatch returns. */
let inFlight: Promise<HygieneTickResult> | null = null;

export interface HygieneTickResult {
	status: 'no-engine' | 'clean' | 'cooldown' | 'dispatched' | 'error';
	report?: HygieneReport;
	dispatched?: { runId: string; agentId: string };
	error?: string;
}

export async function tickVaultHygiene(
	threshold: HygieneThreshold = DEFAULT_HYGIENE_THRESHOLD,
): Promise<HygieneTickResult> {
	if (inFlight) {
		console.log('[vault-hygiene/tick] already running — coalescing to in-flight call');
		return inFlight;
	}
	inFlight = runTick(threshold).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runTick(threshold: HygieneThreshold): Promise<HygieneTickResult> {
	let report: HygieneReport;
	try {
		report = await getHygieneReport();
	} catch (err) {
		const msg = (err as Error).message;
		console.warn(`[vault-hygiene/tick] report failed: ${msg}`);
		return { status: msg.includes('not initialized') ? 'no-engine' : 'error', error: msg };
	}

	if (!isActionable(report, threshold)) {
		return { status: 'clean', report };
	}

	if (state && Date.now() - state.lastDispatchAt < COOLDOWN_MS) {
		const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - state.lastDispatchAt)) / 60_000);
		console.log(`[vault-hygiene/tick] cooldown ${remainingMin}m — last dispatch was recent`);
		return { status: 'cooldown', report };
	}

	const task = buildKeeperTask(report);
	try {
		const generator = dispatchAgent(KEEPER_AGENT_ID, task, {
			mode: 'production',
			sourceMessage: 'heartbeat:vault-hygiene',
		});
		// Drain the stream — we don't care about progress events here.
		// The final return value is the DispatchResult.
		let result: Awaited<ReturnType<typeof generator.next>>;
		do {
			result = await generator.next();
		} while (!result.done);
		const dispatchResult = result.value;
		state = { lastDispatchAt: Date.now() };
		console.log(
			`[vault-hygiene/tick] keeper dispatched: runId=${dispatchResult.runId} status=${dispatchResult.status}`,
		);
		// ADR-043 Pass 2 — fire-and-forget inline-button fan-out for the
		// three wired vault-hygiene buckets. The escalator has per-run
		// dedup on `generatedAt` (refreshed each invocation), so this
		// doesn't double-fire within the same heartbeat window. It runs
		// AFTER keeper because keeper's auto-fixes may resolve anomalies
		// before we'd ever surface them as buttons.
		void emitVaultHygieneEscalations()
			.then((r) => {
				if (r.ok && (r.sent ?? 0) > 0) {
					console.log(
						`[vault-hygiene/tick] inline-button fan-out: sent=${r.sent} skipped=${r.skipped} byBucket=${JSON.stringify(r.byBucket ?? {})}`,
					);
				} else if (!r.ok) {
					console.warn(`[vault-hygiene/tick] inline-button fan-out failed: ${r.error}`);
				}
			})
			.catch((err) => {
				console.warn(`[vault-hygiene/tick] inline-button fan-out threw: ${(err as Error).message}`);
			});
		return {
			status: 'dispatched',
			report,
			dispatched: { runId: dispatchResult.runId, agentId: KEEPER_AGENT_ID },
		};
	} catch (err) {
		const msg = (err as Error).message;
		console.warn(`[vault-hygiene/tick] dispatch failed: ${msg}`);
		return { status: 'error', error: msg, report };
	}
}

function isActionable(report: HygieneReport, threshold: HygieneThreshold): boolean {
	const t = report.totals;
	if (t.orphans + t.statusContradictions >= threshold.orphansPlusContradictions) return true;
	if (t.staleInbox >= threshold.staleInbox) return true;
	if (t.governanceViolations >= threshold.governanceViolations) return true;
	// Misplaced notes — fire whenever even one HIGH-confidence misplacement
	// is present. Keeper's job here is fast (just `mv` + reindex), so we
	// don't want to let clutter build up across multiple ticks.
	if (t.misplacedNotes >= 1 && report.misplacedNotes.some(n => n.confidence === 'high')) return true;
	// Inbox decisions — fire when there are aging queued personal mails or
	// stuck-unknown transactional rows. Keeper surfaces the list to Telegram
	// so the operator can decide (save / archive / reply / mark processed).
	if (t.inboxDecisions >= 1) return true;
	return false;
}

/** Build the keeper task prompt. Keeper reads the totals + sample
 *  issue list, then walks each item with its existing tools. */
function buildKeeperTask(report: HygieneReport): string {
	const t = report.totals;
	const lines: string[] = [
		'Vault hygiene tick (heartbeat-driven, ADR-010).',
		'',
		`Health score: ${report.healthScore}/100`,
		`Indexed: ${t.indexed} notes`,
		`Issues: orphans=${t.orphans}, unresolved=${t.unresolved}, stale-inbox=${t.staleInbox}, status-contradictions=${t.statusContradictions}, governance-violations=${t.governanceViolations}, misplaced-notes=${t.misplacedNotes}, inbox-decisions=${t.inboxDecisions}`,
		'',
		'Auto-fix scope (per ADR-010): orphans (add to nearest index.md), stale-inbox notes with valid `type` (file by zone), governance violations that are missing-but-derivable frontmatter fields, high-confidence misplaced notes (move to `suggestedZone` via `POST /api/vault/move`).',
		'Escalate (do NOT auto-fix): dead links (could be a typo OR a renamed file), status contradictions, inbox notes with no `type`.',
		'',
		'Full payload below — walk it issue by issue:',
		'',
		'```json',
		JSON.stringify(
			{
				orphans: report.orphans,
				unresolved: report.unresolved,
				staleInbox: report.staleInbox,
				statusContradictions: report.statusContradictions,
				governanceViolations: report.governanceViolations,
				misplacedNotes: report.misplacedNotes,
			},
			null,
			2,
		),
		'```',
		'',
		'When done, summarize "auto-fixed N, escalating M" and use the escalate snippet from your prompt to push the M items to Telegram. If nothing remains, end with a single "vault is clean" line and skip the Telegram push.',
	];
	return lines.join('\n');
}

/** Test-only — reset the in-memory cooldown state. */
export function _resetHygieneTickState(): void {
	state = null;
	inFlight = null;
}
