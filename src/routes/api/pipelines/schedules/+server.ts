import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRunHistory, getAutomationConfig, isTriggerEnabled, getTriggerSecret } from '$lib/pipeline/index.js';

/** GET /api/pipelines/schedules — pipeline trigger configs + run history.
 *
 *  Cron scheduling extracted to `/scheduler` per ADR-005 — this
 *  endpoint no longer surfaces `schedule` or `scheduleEnabled` fields.
 *  The route name is preserved for client compatibility; all returned
 *  entries are pipelines with at least one of: triggerEnabled (webhook),
 *  triggerSecret, or recent run history. */
export const GET: RequestHandler = async ({ url }) => {
	const historyOnly = url.searchParams.get('history');

	if (historyOnly !== null) {
		const limit = parseInt(url.searchParams.get('limit') || '20', 10);
		return json({ history: getRunHistory(limit) });
	}

	// Build the trigger list from the run history's distinct pipeline
	// names — that's the only persistent signal we have post-cron-extract.
	const recentHistory = getRunHistory(50);
	const seen = new Set<string>();
	const triggers: {
		name: string;
		triggerEnabled: boolean;
		triggerSecret?: string;
		lastRun?: string;
		lastStatus?: string;
	}[] = [];
	for (const r of recentHistory) {
		if (seen.has(r.pipelineName)) continue;
		seen.add(r.pipelineName);
		const cfg = getAutomationConfig(r.pipelineName);
		triggers.push({
			name: r.pipelineName,
			triggerEnabled: isTriggerEnabled(r.pipelineName),
			triggerSecret: getTriggerSecret(r.pipelineName) || undefined,
			lastRun: r.startedAt,
			lastStatus: r.status,
		});
		// Suppress unused-var warning while keeping cfg available for
		// future extensions (e.g. surfacing watch state here).
		void cfg;
	}

	return json({
		// `schedules` key kept for client back-compat; rename in a future
		// pipeline-page refactor.
		schedules: triggers,
		history: getRunHistory(10),
	});
};

/** POST /api/pipelines/schedules — toggle a schedule on/off.
 *
 *  Deprecated per ADR-005. Returns 410 Gone with a pointer to the
 *  Scheduler API. Old clients that still call this will see a clear
 *  error rather than a silent no-op. */
export const POST: RequestHandler = async () => {
	return json(
		{
			error: 'Pipeline cron scheduling moved to /scheduler (ADR-005). Toggle the corresponding scheduler task instead.',
			gone: true,
		},
		{ status: 410 },
	);
};
