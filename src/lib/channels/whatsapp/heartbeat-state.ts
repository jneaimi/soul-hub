/** Heartbeat persistence — better-sqlite3 at
 *  `~/.soul-hub/data/whatsapp/heartbeat.db`. Three tables:
 *
 *   - proactive_log   — every tick (sent / ack / gated / skipped / error)
 *   - daily_counter   — per-target, per-day count for the maxPerDay gate
 *   - task_state      — per-task lastRunAt for the per-task interval gate
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
