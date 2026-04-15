import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSystemHealth } from '$lib/system/index.js';

/**
 * GET /api/system/health — get last health report + active notification count
 */
export const GET: RequestHandler = async () => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	const report = health.getLastReport();
	return json({
		report,
		activeNotifications: health.notifications.activeCount,
	});
};

/**
 * POST /api/system/health — force a health check now
 */
export const POST: RequestHandler = async () => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	const report = await health.forceCheck();
	return json({
		report,
		activeNotifications: health.notifications.activeCount,
	});
};
