/**
 * project-phases ADR-008 S2 — persistence for assumption audits.
 *
 * Thin DB layer over the `assumption_audits` table (migration v12 in
 * `heartbeat-state.ts`). Scorer + scanner stay pure; this module is
 * the only place that talks to better-sqlite3 for audit rows.
 */

import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';
import type { ScorerResult } from './assumption-scorer.js';

export interface AuditRow {
	id: number;
	session_id: string;
	transcript_path: string;
	audited_at: number;
	score: number;
	deterministic_score: number;
	llm_score: number | null;
	signals: ScorerResult['signals'];
	sample_claims: ScorerResult['sample_claims'];
	linked_projects: string[];
	dismissed_at: number | null;
	dismissed_reason: string | null;
}

export interface SaveAuditInput {
	session_id: string;
	transcript_path: string;
	audited_at: number;
	scorer_result: ScorerResult;
	linked_projects: string[];
}

export function saveAudit(input: SaveAuditInput): number {
	const db = getHeartbeatDb();
	const stmt = db.prepare(`
		INSERT INTO assumption_audits (
			session_id, transcript_path, audited_at, score, deterministic_score,
			llm_score, signals, sample_claims, linked_projects
		) VALUES (
			@session_id, @transcript_path, @audited_at, @score, @deterministic_score,
			NULL, @signals, @sample_claims, @linked_projects
		)
	`);
	const info = stmt.run({
		session_id: input.session_id,
		transcript_path: input.transcript_path,
		audited_at: input.audited_at,
		score: input.scorer_result.score,
		deterministic_score: input.scorer_result.score,
		signals: JSON.stringify(input.scorer_result.signals),
		sample_claims: JSON.stringify(input.scorer_result.sample_claims),
		linked_projects: JSON.stringify(input.linked_projects)
	});
	return Number(info.lastInsertRowid);
}

interface RawAuditRow {
	id: number;
	session_id: string;
	transcript_path: string;
	audited_at: number;
	score: number;
	deterministic_score: number;
	llm_score: number | null;
	signals: string;
	sample_claims: string;
	linked_projects: string;
	dismissed_at: number | null;
	dismissed_reason: string | null;
}

function decode(r: RawAuditRow): AuditRow {
	return {
		id: r.id,
		session_id: r.session_id,
		transcript_path: r.transcript_path,
		audited_at: r.audited_at,
		score: r.score,
		deterministic_score: r.deterministic_score,
		llm_score: r.llm_score,
		signals: JSON.parse(r.signals) as ScorerResult['signals'],
		sample_claims: JSON.parse(r.sample_claims) as ScorerResult['sample_claims'],
		linked_projects: JSON.parse(r.linked_projects) as string[],
		dismissed_at: r.dismissed_at,
		dismissed_reason: r.dismissed_reason
	};
}

export interface QueryAuditsOptions {
	/** Filter to audits whose `linked_projects` JSON-array contains this slug. */
	project?: string;
	/** Lower-bound on audited_at (ms epoch); inclusive. */
	since?: number;
	/** Max rows to return. Default 50, capped at 500. */
	limit?: number;
	/** Include audits the operator dismissed as false positives. Default false. */
	include_dismissed?: boolean;
}

/** Latest-per-session view: when a transcript is re-audited (file grew),
 *  return only the most recent row for that session_id. Project filtering
 *  applied AFTER de-dup. */
export function queryAudits(opts: QueryAuditsOptions = {}): AuditRow[] {
	const db = getHeartbeatDb();
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

	// Step 1: pull the candidate set (latest-per-session), oversize so the
	// post-filter for project membership has room to drop matches.
	const sql = `
		SELECT * FROM assumption_audits
		WHERE id IN (
			SELECT MAX(id) FROM assumption_audits
			${opts.since ? 'WHERE audited_at >= @since' : ''}
			GROUP BY session_id
		)
		${opts.include_dismissed ? '' : 'AND dismissed_at IS NULL'}
		ORDER BY audited_at DESC, id DESC
		LIMIT @oversize
	`;
	const rows = db
		.prepare(sql)
		.all({ since: opts.since ?? 0, oversize: limit * 4 }) as RawAuditRow[];
	const decoded = rows.map(decode);

	if (!opts.project) return decoded.slice(0, limit);

	const slug = opts.project;
	return decoded.filter((r) => r.linked_projects.includes(slug)).slice(0, limit);
}

/** Bucket counts (high/medium/low) over the same set queryAudits would
 *  return. Used by the operator dashboard. */
export function countAudits(opts: QueryAuditsOptions = {}): {
	high_score: number;
	medium_score: number;
	low_score: number;
} {
	const rows = queryAudits({ ...opts, limit: 500 });
	let high = 0;
	let medium = 0;
	let low = 0;
	for (const r of rows) {
		if (r.score > 70) high++;
		else if (r.score >= 40) medium++;
		else low++;
	}
	return { high_score: high, medium_score: medium, low_score: low };
}

/** Latest audited_at per transcript_path — used by the scheduler scanner
 *  to skip transcripts that haven't changed since their last audit. */
export function latestAuditedAtByPath(): Map<string, number> {
	const db = getHeartbeatDb();
	const rows = db
		.prepare(
			`SELECT transcript_path, MAX(audited_at) AS last_audit
			 FROM assumption_audits
			 GROUP BY transcript_path`
		)
		.all() as Array<{ transcript_path: string; last_audit: number }>;
	const map = new Map<string, number>();
	for (const r of rows) map.set(r.transcript_path, r.last_audit);
	return map;
}

/** Test-only helper: wipe the table between fixture runs. */
export function _clearAuditsForTests(): void {
	const db = getHeartbeatDb();
	db.exec('DELETE FROM assumption_audits;');
}
