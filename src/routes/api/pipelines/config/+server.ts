import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { getAutomationConfig, setAutomationConfig, getWatchStatus, parsePipeline } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

/** GET /api/pipelines/config?name=... — get automation config */
export const GET: RequestHandler = async ({ url }) => {
	const name = url.searchParams.get('name');
	if (!name) return json({ error: 'Missing name' }, { status: 400 });
	const autoConfig = getAutomationConfig(name);
	return json({
		...autoConfig,
		watch: autoConfig.watch || null,
		watchStatus: getWatchStatus(name),
	});
};

/** POST /api/pipelines/config — update automation config.
 *
 *  ADR-005: cron scheduling extracted to `/scheduler`. `schedule` and
 *  `scheduleEnabled` are still accepted for backward-compat with older
 *  clients but are silently dropped — declare a Scheduler task with
 *  `type: 'trigger-pipeline'` instead. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { name, schedule, scheduleEnabled, triggerEnabled, triggerSecret, watch } = body as {
		name: string;
		schedule?: string | null;
		scheduleEnabled?: boolean;
		triggerEnabled?: boolean;
		triggerSecret?: string | null;
		watch?: Record<string, unknown>;
	};

	if (!name) return json({ error: 'Missing pipeline name' }, { status: 400 });

	// Validate pipeline exists
	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');
	try {
		await parsePipeline(yamlPath);
	} catch {
		return json({ error: `Pipeline "${name}" not found` }, { status: 404 });
	}

	// Drop legacy schedule fields with a one-line warning.
	if (schedule !== undefined || scheduleEnabled !== undefined) {
		console.warn(
			`[pipelines/config] dropped legacy schedule fields for "${name}" — declare a 'trigger-pipeline' Scheduler task instead (ADR-005)`,
		);
	}

	const update: Record<string, unknown> = {};
	if (triggerEnabled !== undefined) update.triggerEnabled = triggerEnabled;
	if (triggerSecret !== undefined) update.triggerSecret = triggerSecret || undefined;
	if (watch !== undefined) update.watch = watch;

	await setAutomationConfig(name, update);
	return json({ ok: true });
};
