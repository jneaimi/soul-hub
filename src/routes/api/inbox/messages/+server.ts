import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listMessages, getMessage, getInboxStats } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/messages — list messages with filtering
 *   ?account=id     — filter by account
 *   ?folder=INBOX   — filter by folder
 *   ?search=query   — FTS5 search
 *   ?limit=50       — page size
 *   ?offset=0       — pagination offset
 */
export const GET: RequestHandler = async ({ url }) => {
	const accountId = url.searchParams.get('account') || undefined;
	const folder = url.searchParams.get('folder') || undefined;
	const search = url.searchParams.get('search') || undefined;
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);
	const offset = parseInt(url.searchParams.get('offset') || '0', 10);

	if (limit < 1 || limit > 200) {
		return json({ error: 'limit must be 1-200' }, { status: 400 });
	}
	if (offset < 0) {
		return json({ error: 'offset must be >= 0' }, { status: 400 });
	}

	const { messages, total } = listMessages({ accountId, folder, search, limit, offset });
	const stats = getInboxStats();

	return json({ messages, total, stats });
};
