import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSchedules, toggleSchedule, getRunHistory } from '$lib/pipeline/index.js';

/** GET /api/pipelines/schedules — list automation configs and run history */
export const GET: RequestHandler = async ({ url }) => {
	const historyOnly = url.searchParams.get('history');

	if (historyOnly !== null) {
		const limit = parseInt(url.searchParams.get('limit') || '20', 10);
		return json({ history: getRunHistory(limit) });
	}

	return json({
		schedules: getSchedules(),
		history: getRunHistory(10),
	});
};

/** POST /api/pipelines/schedules — toggle a schedule on/off */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { name, enabled } = body as { name: string; enabled: boolean };

	if (!name || enabled === undefined) {
		return json({ error: 'Missing name or enabled' }, { status: 400 });
	}

	const ok = toggleSchedule(name, enabled);
	if (!ok) {
		return json({ error: `No schedule found for "${name}"` }, { status: 404 });
	}

	return json({ ok: true, name, enabled });
};
