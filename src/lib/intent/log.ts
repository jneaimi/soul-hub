/** Per ADR-023 Phase 1 — persistent intent decision log.
 *
 *  Replaces the in-memory ring buffer in `whatsapp/router.ts:67` for
 *  durability across restarts. The pattern miner (Phase 1.5, future)
 *  reads this table to propose deterministic routing rules.
 *
 *  Storage: same `~/.soul-hub/data/inbox.db` SQLite file as
 *  `chat_history` (per ADR-021). Schema is created lazily on first
 *  access — no migration step for fresh installs.
 *
 *  Wire shape: every routing decision in `routeFreeForm` writes one
 *  row. Slash commands skip the router and don't get logged (their
 *  intent is unambiguous; nothing to learn). */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';

export type IntentSource = 'regex' | 'llm' | 'pattern' | 'fallback';

export interface IntentDecision {
	ts: number;
	conversationKey: string;
	rawMessage: string;
	normalizedSignature: string;
	pickedRoute: string;
	source: IntentSource;
	confidence?: number;
	latencyMs?: number;
}

export interface IntentLogRow extends IntentDecision {}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS intent_log (
			ts INTEGER NOT NULL,
			conversation_key TEXT NOT NULL,
			raw_message TEXT NOT NULL,
			normalized_signature TEXT NOT NULL,
			picked_route TEXT NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('regex','llm','pattern','fallback')),
			confidence REAL,
			latency_ms INTEGER,
			satisfied INTEGER,
			PRIMARY KEY (conversation_key, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_intent_log_signature
			ON intent_log(normalized_signature, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_intent_log_recent
			ON intent_log(ts DESC);
	`);
}

function db(): Database {
	const handle = getInboxDb();
	if (!schemaReady) {
		ensureSchema(handle);
		schemaReady = true;
	}
	return handle;
}

/** Record one routing decision. Best-effort: the writer never throws;
 *  a logging failure must never break the user-facing reply path. */
export function writeIntentDecision(decision: IntentDecision): void {
	if (!decision.conversationKey || !decision.rawMessage) return;
	try {
		db()
			.prepare(
				`INSERT OR REPLACE INTO intent_log
				 (ts, conversation_key, raw_message, normalized_signature, picked_route, source, confidence, latency_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				decision.ts,
				decision.conversationKey,
				decision.rawMessage,
				decision.normalizedSignature,
				decision.pickedRoute,
				decision.source,
				decision.confidence ?? null,
				decision.latencyMs ?? null,
			);
	} catch (err) {
		console.warn(`[intent-log] write failed: ${(err as Error).message}`);
	}
}

/** Recent rows, newest first. For ad-hoc inspection + the future
 *  miner's seven-day window. */
export function getRecentIntentLog(limit = 50): IntentLogRow[] {
	const rows = db()
		.prepare<[number]>(
			`SELECT ts, conversation_key, raw_message, normalized_signature,
			        picked_route, source, confidence, latency_ms
			 FROM intent_log
			 ORDER BY ts DESC
			 LIMIT ?`,
		)
		.all(limit) as Array<{
		ts: number;
		conversation_key: string;
		raw_message: string;
		normalized_signature: string;
		picked_route: string;
		source: IntentSource;
		confidence: number | null;
		latency_ms: number | null;
	}>;
	return rows.map((r) => ({
		ts: r.ts,
		conversationKey: r.conversation_key,
		rawMessage: r.raw_message,
		normalizedSignature: r.normalized_signature,
		pickedRoute: r.picked_route,
		source: r.source,
		confidence: r.confidence ?? undefined,
		latencyMs: r.latency_ms ?? undefined,
	}));
}

/** Sweep rows older than `retentionDays`. Cheap to call; no-op when
 *  there's nothing to delete. Will be wired to the daily miner task
 *  in Phase 1.5; safe to call manually until then. */
export function pruneIntentLog(retentionDays = 90, now = Date.now()): number {
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const result = db().prepare(`DELETE FROM intent_log WHERE ts < ?`).run(cutoff);
	return result.changes;
}
