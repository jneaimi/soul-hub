/** Heartbeat persistence — better-sqlite3 at
 *  `~/.soul-hub/data/whatsapp/heartbeat.db`. Tables:
 *
 *   - proactive_log   — every tick (sent / ack / gated / skipped / error)
 *   - daily_counter   — per-target, per-day count for the maxPerDay gate
 *   - task_state      — per-task lastRunAt for the per-task interval gate
 *   - commitments     — Slice 5 inferred follow-ups, scoped to (channel, target)
 *   - scheduler_runs  — Phase 1 scheduler run history (owned by scheduler/)
 *   - voice_acks      — Phase 4 voice-queue acks (per ADR-003 amended)
 *
 *  Mirrors the lazy-singleton + WAL pattern from `src/lib/inbox/db.ts`.
 *  Distinct DB from inbox.db (which is the Outlook email cache, unrelated).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../../paths.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	const dir = resolve(soulHubDataDir(), 'whatsapp');
	mkdirSync(dir, { recursive: true });
	return resolve(dir, 'heartbeat.db');
}

export function getHeartbeatDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('busy_timeout = 5000');

	migrate(db);
	return db;
}

export function closeHeartbeatDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS proactive_log (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				ts          INTEGER NOT NULL,
				target      TEXT    NOT NULL,
				task_name   TEXT,
				status      TEXT    NOT NULL,
				text        TEXT,
				tokens_in   INTEGER,
				tokens_out  INTEGER,
				model       TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_proactive_log_ts ON proactive_log(ts DESC);
			CREATE INDEX IF NOT EXISTS idx_proactive_log_target ON proactive_log(target);

			CREATE TABLE IF NOT EXISTS daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);

			CREATE TABLE IF NOT EXISTS task_state (
				task_name    TEXT PRIMARY KEY,
				last_run_at  INTEGER NOT NULL
			);
		`);
		db.pragma('user_version = 1');
	}

	if (version < 2) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS commitments (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				channel         TEXT    NOT NULL,
				target          TEXT    NOT NULL,
				suggested_text  TEXT    NOT NULL,
				due_after_ts    INTEGER NOT NULL,
				status          TEXT    NOT NULL DEFAULT 'pending',
				source_msg_id   TEXT,
				confidence      REAL    NOT NULL,
				created_at      INTEGER NOT NULL,
				surfaced_at     INTEGER,
				dismissed_at    INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_commitments_due
				ON commitments(channel, target, status, due_after_ts);
			CREATE INDEX IF NOT EXISTS idx_commitments_created
				ON commitments(created_at DESC);
		`);
		db.pragma('user_version = 2');
	}

	if (version < 3) {
		// `/img` per-target daily cap. Kept distinct from `daily_counter`
		// (which is the heartbeat budget) so the two budgets don't collide.
		db.exec(`
			CREATE TABLE IF NOT EXISTS img_daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);
		`);
		db.pragma('user_version = 3');
	}

	if (version < 4) {
		// scheduler_runs is owned by `src/lib/scheduler/` (domain-agnostic
		// task registry). It lives in this DB per ADR-002 so future tables
		// (e.g. voice_acks in Phase 4) can join transactionally with run
		// history. The schema definition stays here because heartbeat-state
		// is the single migration owner for this file.
		db.exec(`
			CREATE TABLE IF NOT EXISTS scheduler_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id         TEXT    NOT NULL,
				scheduled_for   TEXT    NOT NULL,
				started_at      TEXT    NOT NULL,
				finished_at     TEXT,
				status          TEXT    NOT NULL,
				duration_ms     INTEGER,
				error_message   TEXT,
				output_summary  TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_scheduler_runs_task_id_started
				ON scheduler_runs(task_id, started_at DESC);
		`);
		db.pragma('user_version = 4');
	}

	if (version < 5) {
		// voice_acks — heartbeat consumer's record of which inbox notes
		// it has already surfaced. Per ADR-003 amended, ack_method = 'auto'
		// on successful delivery. Reply-based ack ('done'/'skip'/'later')
		// lands in Phase 4.5 via UPDATEs to ack_method.
		//
		// note_path is the PK because each inbox note has a stable vault-
		// relative path that uniquely identifies it across reindex events.
		// If the note is later deleted from the vault, the row stays —
		// cheap, and the daily voice_acks cleanup task (TBD) prunes by age.
		db.exec(`
			CREATE TABLE IF NOT EXISTS voice_acks (
				note_path   TEXT    PRIMARY KEY,
				acked_at    INTEGER NOT NULL,
				ack_method  TEXT    NOT NULL DEFAULT 'auto'
			);
			CREATE INDEX IF NOT EXISTS idx_voice_acks_acked_at
				ON voice_acks(acked_at DESC);
		`);
		db.pragma('user_version = 5');
	}

	if (version < 6) {
		// Phase 4.5 — `cooldown_until` supports the `reply-later` ack
		// method. A row with `cooldown_until > now` is treated as acked
		// (won't re-fire). Once the cooldown passes, the row is treated
		// as NOT acked — the note becomes eligible for the next tick to
		// surface again. NULL = no cooldown (auto / reply-done /
		// reply-skip are permanent acks within the inbox 30-day archive
		// window).
		db.exec(`
			ALTER TABLE voice_acks ADD COLUMN cooldown_until INTEGER;
		`);
		db.pragma('user_version = 6');
	}

	if (version < 7) {
		// Phase 7 — Vault-Scout idempotency + audit. Owned conceptually
		// by `src/lib/scheduler/handlers/vault-scout.ts` per ADR-007;
		// schema lives here for the same reason scheduler_runs / voice_acks
		// do (single migration owner per DB file).
		//
		// vault_scout_decisions: per-candidate decision record. PK on
		// candidate_id ensures each candidate is decided AT MOST ONCE
		// (re-running the scout same-day with the same candidates is a
		// no-op). decision = 'queued' | 'skipped' | 'deferred'. note_path
		// is set only for 'queued' decisions.
		//
		// vault_scout_rejects: audit log for synthesizer outputs that
		// failed validation (bad date, missing required field, etc.).
		// Not user-visible; useful for debugging prompt drift.
		db.exec(`
			CREATE TABLE IF NOT EXISTS vault_scout_decisions (
				candidate_id  TEXT    PRIMARY KEY,
				decision      TEXT    NOT NULL,
				decided_at    INTEGER NOT NULL,
				note_path     TEXT,
				model_used    TEXT,
				reason        TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_decisions_decided_at
				ON vault_scout_decisions(decided_at DESC);

			CREATE TABLE IF NOT EXISTS vault_scout_rejects (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				candidate_id      TEXT,
				raw_synth_output  TEXT,
				reject_reason     TEXT NOT NULL,
				recorded_at       INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_rejects_recorded_at
				ON vault_scout_rejects(recorded_at DESC);
		`);
		db.pragma('user_version = 7');
	}
}

/** Heartbeat run statuses logged to `proactive_log`. */
export type HeartbeatStatus =
	| 'sent'
	| 'ack'
	| 'skipped_empty'
	| 'gated_active_hours'
	| 'gated_cap'
	| 'gated_mute'
	| 'error';

export interface LogEntry {
	ts: number;
	target: string;
	taskName?: string;
	status: HeartbeatStatus;
	text?: string;
	tokensIn?: number;
	tokensOut?: number;
	model?: string;
}

export function appendLog(entry: LogEntry): void {
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO proactive_log (ts, target, task_name, status, text, tokens_in, tokens_out, model)
		 VALUES (@ts, @target, @taskName, @status, @text, @tokensIn, @tokensOut, @model)`,
	);
	stmt.run({
		ts: entry.ts,
		target: entry.target,
		taskName: entry.taskName ?? null,
		status: entry.status,
		text: entry.text ?? null,
		tokensIn: entry.tokensIn ?? null,
		tokensOut: entry.tokensOut ?? null,
		model: entry.model ?? null,
	});
}

export function recentLog(limit = 20): LogEntry[] {
	const rows = getHeartbeatDb()
		.prepare(
			`SELECT ts, target, task_name as taskName, status, text, tokens_in as tokensIn, tokens_out as tokensOut, model
			 FROM proactive_log ORDER BY ts DESC LIMIT ?`,
		)
		.all(limit) as LogEntry[];
	return rows;
}

/** YYYY-MM-DD in the given IANA timezone. Used for the per-day cap key
 *  so the day boundary follows the user's wall clock, not UTC. */
export function ymdInTimezone(timezone: string, at = Date.now()): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date(at));
}

export function getDailyCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementDailyCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

/** Per-target `/img` count for the current day (in the user's wall-clock
 *  timezone). Distinct from `daily_counter`, which tracks the heartbeat. */
export function getImgCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM img_daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementImgCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO img_daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

export function getTaskLastRun(taskName: string): number | undefined {
	const row = getHeartbeatDb()
		.prepare('SELECT last_run_at FROM task_state WHERE task_name = ?')
		.get(taskName) as { last_run_at: number } | undefined;
	return row?.last_run_at;
}

export function setTaskLastRun(taskName: string, at = Date.now()): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO task_state (task_name, last_run_at) VALUES (?, ?)
			 ON CONFLICT(task_name) DO UPDATE SET last_run_at = excluded.last_run_at`,
		)
		.run(taskName, at);
}

// ─── Commitments (Slice 5) ─────────────────────────────────────────────

export type CommitmentStatus = 'pending' | 'surfaced' | 'dismissed';

export interface CommitmentRow {
	id: number;
	channel: string;
	target: string;
	suggestedText: string;
	dueAfterTs: number;
	status: CommitmentStatus;
	sourceMsgId: string | null;
	confidence: number;
	createdAt: number;
	surfacedAt: number | null;
	dismissedAt: number | null;
}

export interface InsertCommitmentInput {
	channel: string;
	target: string;
	suggestedText: string;
	dueAfterTs: number;
	sourceMsgId: string | null;
	confidence: number;
}

export function insertCommitment(input: InsertCommitmentInput): number {
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO commitments (channel, target, suggested_text, due_after_ts, status, source_msg_id, confidence, created_at)
		 VALUES (@channel, @target, @suggestedText, @dueAfterTs, 'pending', @sourceMsgId, @confidence, @createdAt)`,
	);
	const result = stmt.run({
		channel: input.channel,
		target: input.target,
		suggestedText: input.suggestedText,
		dueAfterTs: input.dueAfterTs,
		sourceMsgId: input.sourceMsgId,
		confidence: input.confidence,
		createdAt: Date.now(),
	});
	return Number(result.lastInsertRowid);
}

const COMMITMENT_SELECT = `
	id, channel, target,
	suggested_text  AS suggestedText,
	due_after_ts    AS dueAfterTs,
	status,
	source_msg_id   AS sourceMsgId,
	confidence,
	created_at      AS createdAt,
	surfaced_at     AS surfacedAt,
	dismissed_at    AS dismissedAt
`;

/** Pending commitments whose due time has arrived, scoped to one
 *  conversation so a commitment from chat A never leaks to chat B. */
export function getDueCommitments(channel: string, target: string, now = Date.now()): CommitmentRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT ${COMMITMENT_SELECT} FROM commitments
			 WHERE channel = ? AND target = ? AND status = 'pending' AND due_after_ts <= ?
			 ORDER BY due_after_ts ASC, id ASC`,
		)
		.all(channel, target, now) as CommitmentRow[];
}

/** Mark commitments as surfaced. Called after the heartbeat tick that
 *  included them — prevents the same commitment from being repeatedly
 *  re-included until the user/agent dismisses it. */
export function markCommitmentsSurfaced(ids: number[], at = Date.now()): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => '?').join(',');
	getHeartbeatDb()
		.prepare(
			`UPDATE commitments SET status = 'surfaced', surfaced_at = ?
			 WHERE id IN (${placeholders})`,
		)
		.run(at, ...ids);
}

export function dismissCommitment(id: number, at = Date.now()): boolean {
	const result = getHeartbeatDb()
		.prepare(
			`UPDATE commitments SET status = 'dismissed', dismissed_at = ?
			 WHERE id = ? AND status != 'dismissed'`,
		)
		.run(at, id);
	return result.changes > 0;
}

/** All non-dismissed commitments for a (channel, target) pair — used by
 *  `/commitments list` slash command. Bounded to keep replies short. */
export function listCommitmentsForTarget(channel: string, target: string, limit = 20): CommitmentRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT ${COMMITMENT_SELECT} FROM commitments
			 WHERE channel = ? AND target = ? AND status != 'dismissed'
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.all(channel, target, limit) as CommitmentRow[];
}

// ─── Voice acks (Phase 4) ──────────────────────────────────────────────

export type VoiceAckMethod = 'auto' | 'reply-done' | 'reply-skip' | 'reply-later';

/** True if the heartbeat has already surfaced this inbox note AND it's
 *  not in an expired cooldown. Voice-queue scanner uses this to filter
 *  out already-surfaced items per ADR-003. A row with `cooldown_until`
 *  in the past is treated as no-longer-acked (the `reply-later` 4-hour
 *  window has elapsed and the note becomes eligible again). */
export function isVoiceAcked(notePath: string, now = Date.now()): boolean {
	const row = getHeartbeatDb()
		.prepare(
			`SELECT cooldown_until FROM voice_acks
			 WHERE note_path = ? LIMIT 1`,
		)
		.get(notePath) as { cooldown_until: number | null } | undefined;
	if (!row) return false;
	// No cooldown set → permanent ack. Cooldown in the future → still acked.
	// Cooldown in the past → expired, treat as not-acked.
	if (row.cooldown_until === null) return true;
	return row.cooldown_until > now;
}

/** Soft-auto-ack window: silent delivery is treated as "seen" for this
 *  long, then the note becomes eligible to re-surface. Reasoning: a
 *  permanent ack on send means anything you don't reply to disappears
 *  forever — bad UX for items that genuinely need a reminder. 24h gives
 *  the user a daily second-chance without re-pinging the same item every
 *  tick. Replies still upgrade the row: 'done'/'skip' cleared to NULL
 *  (permanent), 'later' bumped to a 4h cooldown. */
const SOFT_AUTO_ACK_MS = 24 * 60 * 60 * 1000;

/** Mark one or more notes as acked. For `method='auto'`, the row carries
 *  a 24h `cooldown_until` so silently-delivered items re-surface tomorrow.
 *  For explicit reply-* methods, callers go through `applyReplyAck` (which
 *  UPDATEs an existing auto row), so this path is effectively auto-only.
 *
 *  ON CONFLICT DO UPDATE preserves any reply-* state (the WHERE clause
 *  only touches rows still in `auto` state) — so if the user already said
 *  'done', a subsequent silent re-ack on the same path won't overwrite it.
 *  For auto-only re-surfaces (path was previously soft-acked, cooldown
 *  expired, re-presented this tick), it bumps `acked_at` + `cooldown_until`
 *  forward — keeps the reply-ack 4h window measured from the most recent
 *  surface. */
export function markVoiceAcked(notePaths: string[], method: VoiceAckMethod = 'auto', at = Date.now()): void {
	if (notePaths.length === 0) return;
	const cooldownUntil = method === 'auto' ? at + SOFT_AUTO_ACK_MS : null;
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO voice_acks (note_path, acked_at, ack_method, cooldown_until)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(note_path) DO UPDATE SET
		   acked_at = excluded.acked_at,
		   cooldown_until = excluded.cooldown_until
		 WHERE voice_acks.ack_method = 'auto'`,
	);
	const tx = getHeartbeatDb().transaction((paths: string[]) => {
		for (const p of paths) stmt.run(p, at, method, cooldownUntil);
	});
	tx(notePaths);
}

/** Bulk fetch — voice-queue scanner queries with ~50 inbox-note paths per
 *  tick. One round-trip beats N round-trips. Honours `cooldown_until`:
 *  a row whose cooldown has expired is omitted from the set, so the
 *  scanner re-surfaces the note. */
export function getAckedPaths(notePaths: string[], now = Date.now()): Set<string> {
	if (notePaths.length === 0) return new Set();
	const placeholders = notePaths.map(() => '?').join(',');
	const rows = getHeartbeatDb()
		.prepare(
			`SELECT note_path, cooldown_until FROM voice_acks
			 WHERE note_path IN (${placeholders})
			   AND (cooldown_until IS NULL OR cooldown_until > ?)`,
		)
		.all(...notePaths, now) as { note_path: string; cooldown_until: number | null }[];
	return new Set(rows.map((r) => r.note_path));
}

/** Phase 4.5 — apply a reply-ack to recently auto-acked rows. Called from
 *  the inbound dispatcher when the user replies "done", "skip", or "later"
 *  within the reply-ack window (default 4h — covers normal mobile-reply
 *  latency; the original 30-min "one tick" target was too tight for real
 *  WhatsApp use, where replies arrive whenever the user checks their phone).
 *
 *  Returns the number of rows updated. Zero means "no recent voice surface
 *  to ack" — the dispatcher falls through to normal intent routing so a
 *  bare word like "done" still flows to vault-chat in conversation context.
 *
 *  - reply-done / reply-skip: permanent ack. cooldown_until cleared to NULL.
 *  - reply-later: 4-hour cooldown. Note becomes re-eligible after that.
 *
 *  Only updates rows currently `ack_method = 'auto'` — avoids overwriting
 *  prior reply-acks. Edge: upgrading 'reply-later' → 'reply-done' is not
 *  supported in v1; deferred until a real use case emerges.
 */
export type ReplyAckMethod = 'reply-done' | 'reply-skip' | 'reply-later';

const REPLY_LATER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const REPLY_ACK_WINDOW_MS = 4 * 60 * 60 * 1000;

export function applyReplyAck(
	method: ReplyAckMethod,
	withinMs = REPLY_ACK_WINDOW_MS,
	now = Date.now(),
): number {
	const cutoff = now - withinMs;
	const cooldown = method === 'reply-later' ? now + REPLY_LATER_COOLDOWN_MS : null;
	const result = getHeartbeatDb()
		.prepare(
			`UPDATE voice_acks
			 SET ack_method = ?, cooldown_until = ?
			 WHERE ack_method = 'auto' AND acked_at >= ?`,
		)
		.run(method, cooldown, cutoff);
	return result.changes;
}

/** Phase 4.6 — read-only inverse of `applyReplyAck`. Returns the most
 *  recent auto-acked note paths within the reply-ack window. Used by the
 *  inbound dispatcher's `more` reply: list the items currently eligible
 *  for done/skip/later so the user can read them at the source. No
 *  side-effects — does not mutate ack state. */
export function getRecentVoiceSurface(
	withinMs = REPLY_ACK_WINDOW_MS,
	now = Date.now(),
): { notePath: string; ackedAt: number }[] {
	const cutoff = now - withinMs;
	return getHeartbeatDb()
		.prepare(
			`SELECT note_path AS notePath, acked_at AS ackedAt FROM voice_acks
			 WHERE ack_method = 'auto' AND acked_at >= ?
			 ORDER BY acked_at DESC`,
		)
		.all(cutoff) as { notePath: string; ackedAt: number }[];
}

/** Daily cleanup hook — drop ack rows older than `maxAgeMs`. The note
 *  itself ages out via inbox/CLAUDE.md's 30-day archive rule, but the
 *  ack row would otherwise grow forever. Default 30 days matches inbox
 *  archive cadence. */
export function pruneOldVoiceAcks(maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()): number {
	const cutoff = now - maxAgeMs;
	const result = getHeartbeatDb()
		.prepare('DELETE FROM voice_acks WHERE acked_at < ?')
		.run(cutoff);
	return result.changes;
}

// ─── Vault-Scout decisions (Phase 7) ───────────────────────────────────

export type ScoutDecision = 'queued' | 'skipped' | 'deferred';

export interface ScoutDecisionRow {
	candidate_id: string;
	decision: ScoutDecision;
	decided_at: number;
	note_path: string | null;
	model_used: string | null;
	reason: string | null;
}

/** Bulk-check which candidate ids have already been decided. Vault-Scout
 *  uses this before sending candidates to the synthesizer — already-
 *  decided candidates are filtered out so we don't re-evaluate (cost +
 *  duplicate output prevention). */
export function getDecidedCandidateIds(candidateIds: string[]): Set<string> {
	if (candidateIds.length === 0) return new Set();
	const placeholders = candidateIds.map(() => '?').join(',');
	const rows = getHeartbeatDb()
		.prepare(`SELECT candidate_id FROM vault_scout_decisions WHERE candidate_id IN (${placeholders})`)
		.all(...candidateIds) as { candidate_id: string }[];
	return new Set(rows.map((r) => r.candidate_id));
}

export interface InsertScoutDecision {
	candidateId: string;
	decision: ScoutDecision;
	notePath?: string | null;
	modelUsed?: string | null;
	reason?: string | null;
}

/** Idempotent INSERT — the UNIQUE constraint on candidate_id rejects
 *  duplicates, so concurrent runs with the same candidate are safe.
 *  Returns true on first insert, false if the candidate was already
 *  decided. */
export function recordScoutDecision(input: InsertScoutDecision, at = Date.now()): boolean {
	const result = getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_decisions (candidate_id, decision, decided_at, note_path, model_used, reason)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(candidate_id) DO NOTHING`,
		)
		.run(
			input.candidateId,
			input.decision,
			at,
			input.notePath ?? null,
			input.modelUsed ?? null,
			input.reason ?? null,
		);
	return result.changes > 0;
}

/** Audit-only — records a synthesizer output that failed validation
 *  (bad date, missing required field, parse error). Not surfaced to the
 *  user; useful for `[vault-scout] N rejects this run` log lines and
 *  for diagnosing prompt drift. */
export function recordScoutReject(
	candidateId: string | null,
	rawOutput: string | null,
	reason: string,
	at = Date.now(),
): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_rejects (candidate_id, raw_synth_output, reject_reason, recorded_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(candidateId, rawOutput, reason, at);
}

export function recentScoutDecisions(limit = 50): ScoutDecisionRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT candidate_id, decision, decided_at, note_path, model_used, reason
			 FROM vault_scout_decisions
			 ORDER BY decided_at DESC LIMIT ?`,
		)
		.all(limit) as ScoutDecisionRow[];
}
