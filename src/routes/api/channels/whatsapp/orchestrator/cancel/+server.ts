/**
 * POST /api/channels/whatsapp/orchestrator/cancel
 *
 * Body: { jid: string }
 * Response: { ok: true, cancelled: { runId, agentId, startedAt } | null }
 *
 * Cancels any active orchestrator-initiated agent run for the given JID.
 * Idempotent — returns `cancelled: null` if nothing was running.
 */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { cancelByJid } from '$lib/orchestrator/index.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { jid?: string };
	try {
		body = (await request.json()) as { jid?: string };
	} catch {
		throw error(400, 'Invalid JSON.');
	}

	const jid = body.jid?.trim();
	if (!jid) throw error(400, 'Missing `jid`.');

	const cancelled = cancelByJid(jid);
	return json({
		ok: true,
		cancelled: cancelled
			? {
					runId: cancelled.runId,
					agentId: cancelled.agentId,
					startedAt: cancelled.startedAt,
				}
			: null,
	});
};
