/**
 * Layer 2 inbox filter — worker entry point.
 *
 * Lifecycle (mirrors src/lib/inbox/sync.ts):
 *   startFilterWorker() — auth probe → cold-start sweep → setInterval(tick, 10s)
 *   stopFilterWorker()  — clearInterval, let in-flight batch complete or timeout
 *
 * Per tick:
 *   1. Skip if inFlight or backoffUntil > now
 *   2. Fetch up to 25 rows (process_status='new' AND filtered_at IS NULL)
 *   3. Group by account; refetch headers from IMAP (BODY.PEEK[HEADER])
 *   4. For each row:
 *      a. Cache hit → applyClassification + bump cache; done
 *      b. Rule match → applyClassification + set cache; done
 *      c. Gray area → add to LLM batch
 *   5. Flush LLM batch in chunks of 8 via classifyBatch()
 *   6. Persist results + cache writes
 *
 * Concurrency: single in-flight flag — overlapping ticks are dropped.
 * Failure: each error class drives the retry/backoff/alert policy (see
 * handleLLMFailure). Rows stuck in `new` for 7d get promoted to
 * unclassified/queued by the prune sweep (see db.ts:pruneOldMessages).
 *
 * Kill switches (~/.soul-hub/.env):
 *   INBOX_FILTER_DISABLED=1         → worker skips startup entirely
 *   INBOX_FILTER_LLM_DISABLED=1     → rules-only mode, gray area stays 'new'
 *   INBOX_FILTER_COLDSTART_SKIP=1   → skip the historical sweep, forward-only
 *
 * See ADR 2026-05-11-inbox-processing-filter-layer.
 */

import {
	listMessagesForFiltering,
	listFilterRules,
	getFilterCache,
	setFilterCache,
	bumpFilterCacheHit,
	applyClassification,
	setMessageHeaderSignals,
	getAccount,
	getMessage,
	reclassifyBySignature,
} from './db.js';
import type { InboxMessage, FilterCategory } from './types.js';
import { fetchImapHeaders } from './body.js';
import {
	classifyByRules,
	parseHeaderSignals,
	cacheSignature,
} from './filter-rules.js';
import {
	probeClaudeAuth,
	classifyBatch,
	type BatchEntry,
	type LLMOutcome,
} from './filter-llm.js';
import {
	markFilterFailed,
	markFilterRecovered,
} from './filter-notifications.js';

// ── Module state ──

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let llmAvailable = false;
let lastTickAt: number | null = null;
let lastError: string | null = null;
let backoffUntilMs = 0;
let consecutiveLLMFailures = 0;

const TICK_INTERVAL_MS = 10_000;
const TICK_BATCH_LIMIT = 25;
const COLD_START_CHUNK = 200;
const LLM_BATCH_SIZE = 8;

// Backoff schedule by error class (ms).
const BACKOFF_RATE_LIMIT = [5 * 60_000, 15 * 60_000, 30 * 60_000];
let rateLimitStage = 0;

// ── Env switches ──

function isFilterDisabled(): boolean {
	return process.env.INBOX_FILTER_DISABLED === '1';
}
function isLLMDisabled(): boolean {
	return process.env.INBOX_FILTER_LLM_DISABLED === '1';
}
function isColdStartSkipped(): boolean {
	return process.env.INBOX_FILTER_COLDSTART_SKIP === '1';
}

// ── Public lifecycle ──

export async function startFilterWorker(): Promise<void> {
	if (isFilterDisabled()) {
		console.log('[inbox-filter] Disabled via INBOX_FILTER_DISABLED=1');
		return;
	}

	// Auth probe — sets llmAvailable. Failure → rules-only mode + Telegram alert.
	const probe = await probeClaudeAuth();
	llmAvailable = probe.ok;
	if (!llmAvailable) {
		console.warn(`[inbox-filter] Auth probe failed: ${probe.message}`);
		const cls = /(binary|not found|enoent|spawn)/i.test(probe.message) ? 'binary-missing' : 'auth';
		markFilterFailed(cls, probe.message);
	} else {
		console.log('[inbox-filter] Auth probe ok — LLM available');
	}

	// Cold-start sweep (may take 5-15 minutes for a 2000+ message backlog).
	// We DON'T await this from hooks.server.ts (the start call is .then()'d
	// fire-and-forget), so SvelteKit boot is not blocked. The interval below
	// only starts after cold-start completes, so there's no race on rows.
	if (isColdStartSkipped()) {
		console.log('[inbox-filter] Cold-start skipped via INBOX_FILTER_COLDSTART_SKIP=1');
	} else {
		try {
			await runColdStart();
		} catch (err) {
			console.error('[inbox-filter] Cold-start error:', err);
			lastError = `cold-start: ${(err as Error).message}`;
		}
	}

	interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
	console.log(`[inbox-filter] Worker started (poll ${TICK_INTERVAL_MS / 1000}s)`);
}

export async function stopFilterWorker(): Promise<void> {
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
	// We don't await any in-flight batch; setInterval-driven ticks have their
	// own 30s LLM timeout. The next process boot picks up where we left off
	// via the `filtered_at IS NULL` idempotency.
	console.log('[inbox-filter] Worker stopped');
}

/** Diagnostic — feeds GET /api/inbox/filter/stats. */
export function getFilterWorkerStatus(): {
	enabled: boolean;
	llmAvailable: boolean;
	llmDisabled: boolean;
	lastTickAt: number | null;
	lastError: string | null;
	backoffUntilMs: number;
} {
	return {
		enabled: !isFilterDisabled(),
		llmAvailable,
		llmDisabled: isLLMDisabled(),
		lastTickAt,
		lastError,
		backoffUntilMs,
	};
}

// ── Cold-start sweep ──

async function runColdStart(): Promise<void> {
	const workerStartTs = Date.now();
	console.log('[inbox-filter] Cold-start sweep beginning…');
	let totalProcessed = 0;
	let totalClassified = 0;

	while (true) {
		if (Date.now() < backoffUntilMs) {
			console.warn('[inbox-filter] Cold-start paused — backoff active');
			return;
		}
		const messages = listMessagesForFiltering({
			workerStartTs,
			limit: COLD_START_CHUNK,
		});
		if (messages.length === 0) break;

		const summary = await processChunk(messages);
		totalProcessed += summary.processed;
		totalClassified += summary.cacheHits + summary.ruleHits + summary.llmHits;
		console.log(
			`[inbox-filter] cold-start chunk: processed=${summary.processed} ` +
				`cache=${summary.cacheHits} rule=${summary.ruleHits} llm=${summary.llmHits} ` +
				`gray=${summary.grayLeftover} failed=${summary.failed}`,
		);
	}

	console.log(
		`[inbox-filter] Cold-start complete. processed=${totalProcessed} classified=${totalClassified}`,
	);
}

// ── Steady-state tick ──

async function tick(): Promise<void> {
	if (inFlight) return;
	if (Date.now() < backoffUntilMs) return;
	inFlight = true;
	try {
		const messages = listMessagesForFiltering({ limit: TICK_BATCH_LIMIT });
		if (messages.length === 0) {
			lastTickAt = Date.now();
			return;
		}
		await processChunk(messages);
	} catch (err) {
		console.error('[inbox-filter] tick error:', err);
		lastError = (err as Error).message ?? String(err);
	} finally {
		lastTickAt = Date.now();
		inFlight = false;
	}
}

// ── Chunk processor (used by both cold-start and tick) ──

interface ChunkSummary {
	processed: number;
	cacheHits: number;
	ruleHits: number;
	llmHits: number;
	grayLeftover: number;
	failed: number;
}

async function processChunk(messages: InboxMessage[]): Promise<ChunkSummary> {
	const summary: ChunkSummary = {
		processed: messages.length,
		cacheHits: 0,
		ruleHits: 0,
		llmHits: 0,
		grayLeftover: 0,
		failed: 0,
	};

	const rules = listFilterRules({ enabledOnly: true });

	// Group by account so we open at most one IMAP connection per account
	// per chunk for header refetch.
	const byAccount = new Map<string, InboxMessage[]>();
	for (const m of messages) {
		const list = byAccount.get(m.accountId) ?? [];
		list.push(m);
		byAccount.set(m.accountId, list);
	}

	const grayArea: BatchEntry[] = [];
	const grayMessages = new Map<number, InboxMessage>();

	for (const [accountId, msgs] of byAccount) {
		const account = getAccount(accountId);
		if (!account) {
			console.warn(`[inbox-filter] Skipping ${msgs.length} messages — account ${accountId} not found`);
			continue;
		}

		// 1. Cache pass — handle anything we've seen before WITHOUT needing
		// header refetch. Cuts IMAP traffic significantly post-cold-start.
		const remaining: InboxMessage[] = [];
		for (const msg of msgs) {
			const sig = cacheSignature(msg);
			const cached = getFilterCache(sig);
			if (cached) {
				applyClassification(msg.id, {
					category: cached.category,
					reason: 'cache:hit',
				});
				bumpFilterCacheHit(sig);
				summary.cacheHits++;
				continue;
			}
			remaining.push(msg);
		}

		if (remaining.length === 0) continue;

		// 2. Header refetch — one IMAP call per account for the cache-miss UIDs.
		let headersMap: Map<number, string>;
		try {
			headersMap = await fetchImapHeaders(account, remaining.map((m) => m.uid));
		} catch (err) {
			console.warn(
				`[inbox-filter] Header refetch failed for ${account.email}: ${(err as Error).message}. ` +
					`Falling back to envelope-only rules for this chunk.`,
			);
			headersMap = new Map();
			summary.failed += remaining.length;
			// Don't abort — rules still match on envelope.
		}

		// 3. Rule pass per remaining message.
		for (const msg of remaining) {
			const rawHeaders = headersMap.get(msg.uid) ?? null;
			const signals = parseHeaderSignals(rawHeaders ?? '');
			const signalsJson = JSON.stringify(signals);

			const sig = cacheSignature(msg);
			const result = classifyByRules(rules, msg, rawHeaders);
			if (result) {
				applyClassification(msg.id, {
					category: result.category,
					reason: result.reason,
					headerSignalsJson: signalsJson,
				});
				setFilterCache({
					signature: sig,
					category: result.category,
					reason: result.reason,
				});
				summary.ruleHits++;
				continue;
			}

			// 4. Gray area — persist parsed signals + queue for LLM.
			setMessageHeaderSignals(msg.id, signalsJson);
			grayArea.push({
				id: msg.id,
				fromAddress: msg.fromAddress,
				subject: msg.subject,
				bodyPreview: msg.bodyPreview,
			});
			grayMessages.set(msg.id, msg);
		}
	}

	// 5. LLM batch — flush gray area in chunks of LLM_BATCH_SIZE.
	if (grayArea.length > 0 && llmAvailable && !isLLMDisabled()) {
		for (let i = 0; i < grayArea.length; i += LLM_BATCH_SIZE) {
			const chunk = grayArea.slice(i, i + LLM_BATCH_SIZE);
			const outcome = await classifyBatch(chunk);
			if (!outcome.ok) {
				handleLLMFailure(outcome);
				summary.grayLeftover += chunk.length;
				// Stop the loop — backoff is set, rows stay 'new' for retry.
				break;
			}
			for (const r of outcome.results) {
				const original = grayMessages.get(r.id);
				if (!original) continue;
				applyClassification(r.id, {
					category: r.category,
					reason: `llm:${r.category}`,
				});
				setFilterCache({
					signature: cacheSignature(original),
					category: r.category,
					reason: `llm:${r.category}`,
				});
				summary.llmHits++;
			}
			// Track results that did not parse — those rows stay 'new' for retry.
			const classifiedIds = new Set(outcome.results.map((r) => r.id));
			summary.grayLeftover += chunk.filter((b) => !classifiedIds.has(b.id)).length;

			// Successful classification clears prior alerts AND the stale
			// `lastError` diagnostic (so /api/inbox/filter/stats reflects
			// current state, not the last-seen error from minutes ago).
			if (outcome.results.length > 0) {
				consecutiveLLMFailures = 0;
				rateLimitStage = 0;
				lastError = null;
				markFilterRecovered();
			}
		}
	} else if (grayArea.length > 0) {
		summary.grayLeftover += grayArea.length;
	}

	return summary;
}

// ── Failure handling ──

function handleLLMFailure(outcome: Extract<LLMOutcome, { ok: false }>): void {
	consecutiveLLMFailures++;
	lastError = `llm:${outcome.errorClass}: ${outcome.message.slice(0, 160)}`;

	switch (outcome.errorClass) {
		case 'auth': {
			llmAvailable = false;
			backoffUntilMs = Date.now() + 60 * 60_000; // 1 hour cool-off
			markFilterFailed('auth', outcome.message);
			break;
		}
		case 'spawn': {
			llmAvailable = false;
			backoffUntilMs = Date.now() + 60 * 60_000;
			markFilterFailed('binary-missing', outcome.message);
			break;
		}
		case 'rate-limit': {
			const stage = Math.min(rateLimitStage, BACKOFF_RATE_LIMIT.length - 1);
			const wait = BACKOFF_RATE_LIMIT[stage];
			backoffUntilMs = Date.now() + wait;
			rateLimitStage++;
			if (wait >= 15 * 60_000) {
				markFilterFailed('rate-limit', `Backing off for ${Math.round(wait / 60_000)} min`);
			}
			break;
		}
		case 'timeout':
		case 'network':
		case 'unknown':
		case 'parse':
		default: {
			// Soft retry — next tick will pick up the same rows.
			// 3+ consecutive failures of the same class → escalate as 'persistent'.
			if (consecutiveLLMFailures >= 3) {
				backoffUntilMs = Date.now() + 5 * 60_000;
				markFilterFailed('persistent', `${outcome.errorClass}: ${outcome.message}`);
			}
			break;
		}
	}
}

// ── Correction loop (called from API + agent tool) ──

/**
 * Apply a user/agent correction. Updates the cache and (if scope='pattern')
 * re-classifies all sibling messages in 'new' or 'skipped' state. Returns
 * the number of sibling rows that were updated (does not count the row that
 * was the source of the correction unless its state changed too).
 */
export function correctClassification(
	messageId: number,
	input: {
		category: FilterCategory;
		scope?: 'this' | 'pattern';
		reason?: string;
	},
): { ok: boolean; siblingsUpdated: number; reason?: string } {
	const msg = getMessage(messageId);
	if (!msg) return { ok: false, siblingsUpdated: 0, reason: 'not_found' };

	const scope = input.scope ?? 'pattern';
	const reason = input.reason ?? `user-corrected:${input.category}`;
	const sig = cacheSignature(msg);

	// 1. Always update this row. preserveProcessed=true keeps agent-handled
	// rows in the `processed` state even when the operator reclassifies them
	// — the agent's work doesn't get re-queued.
	applyClassification(messageId, {
		category: input.category,
		reason,
		preserveProcessed: true,
	});

	// 2. Update cache (user-corrected).
	setFilterCache({
		signature: sig,
		category: input.category,
		reason,
		userCorrected: true,
	});

	// 3. Sibling pass. Exclude the source row so the returned count is the
	// true number of OTHER rows reclassified (no off-by-one to back out).
	let siblingsUpdated = 0;
	if (scope === 'pattern') {
		siblingsUpdated = reclassifyBySignature(
			sig,
			input.category,
			reason,
			cacheSignature,
			messageId,
		);
	}

	return { ok: true, siblingsUpdated };
}
