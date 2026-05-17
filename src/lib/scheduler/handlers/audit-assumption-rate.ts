/** Scheduler handler: audit-assumption-rate-scan (project-phases ADR-008 S2).
 *
 *  Periodic offline scan of Claude Code session transcripts. For each
 *  transcript that has changed since its last audit, the handler runs
 *  the Layer A scorer + extractLinkedProjects, then persists one row
 *  per audit to `assumption_audits`.
 *
 *  Settings shape:
 *    {
 *      id: 'audit-assumption-rate-scan',
 *      type: 'audit-assumption-rate',
 *      cron: '0 *​/6 * * *',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        maxCandidates?: 50,     // default 50; cap per tick
 *        minScoreToStore?: 0,    // default 0 — store ALL audits regardless
 *                                // of score. Filtering is the UI's job.
 *      }
 *    }
 *
 *  The handler returns a JSON summary that lands in `scheduler_runs.output_summary`,
 *  same shape as the other handlers (intent-mining, vault-scout, etc.).
 */

import { readFileSync } from 'node:fs';
import { scoreTranscript } from '../../audit/assumption-scorer.js';
import { extractLinkedProjects } from '../../audit/extract-linked-projects.js';
import { saveAudit, latestAuditedAtByPath } from '../../audit/persister.js';
import { scanTranscripts } from '../../audit/scan-transcripts.js';
import type { TaskFn } from '../task-types.js';

interface AuditAssumptionRateParams {
	maxCandidates?: number;
	minScoreToStore?: number;
}

export interface AuditScanSummary {
	scanned_dirs: number;
	candidates: number;
	skipped_unchanged: number;
	skipped_empty: number;
	scored: number;
	stored: number;
	skipped_below_threshold: number;
	failed: number;
	high_score_audits: number;
	cumulative_score_sum: number;
	took_ms: number;
}

export function auditAssumptionRateFactory(rawParams: unknown): TaskFn {
	const params: AuditAssumptionRateParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as AuditAssumptionRateParams)
			: {};
	const maxCandidates = params.maxCandidates ?? 50;
	const minScoreToStore = params.minScoreToStore ?? 0;

	return async (ctx) => {
		const startedAt = Date.now();
		const summary: AuditScanSummary = {
			scanned_dirs: 0,
			candidates: 0,
			skipped_unchanged: 0,
			skipped_empty: 0,
			scored: 0,
			stored: 0,
			skipped_below_threshold: 0,
			failed: 0,
			high_score_audits: 0,
			cumulative_score_sum: 0,
			took_ms: 0
		};

		const watermark = latestAuditedAtByPath();
		const scan = scanTranscripts({
			latestAuditedAtByPath: watermark,
			maxCandidates
		});
		summary.scanned_dirs = scan.scanned_dirs;
		summary.candidates = scan.candidates.length;
		summary.skipped_unchanged = scan.skipped_unchanged;
		summary.skipped_empty = scan.skipped_empty;

		for (const candidate of scan.candidates) {
			if (ctx?.signal.aborted) break;
			try {
				const content = readFileSync(candidate.path, 'utf8');
				const result = scoreTranscript(content);
				summary.scored++;
				summary.cumulative_score_sum += result.score;
				if (result.score > 70) summary.high_score_audits++;
				if (result.score < minScoreToStore) {
					summary.skipped_below_threshold++;
					continue;
				}
				const projects = extractLinkedProjects(content);
				saveAudit({
					session_id: result.session_id ?? candidate.path.split('/').pop() ?? '',
					transcript_path: candidate.path,
					audited_at: Math.round(candidate.mtime_ms),
					scorer_result: result,
					linked_projects: projects
				});
				summary.stored++;
			} catch (err) {
				summary.failed++;
				console.error(
					`[audit-assumption-rate] failed for ${candidate.path}:`,
					err instanceof Error ? err.message : err
				);
			}
		}

		summary.took_ms = Date.now() - startedAt;
		return summary;
	};
}
