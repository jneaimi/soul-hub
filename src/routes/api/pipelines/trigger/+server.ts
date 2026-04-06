import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { executeScheduledRun, parsePipeline } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.marketplaceDir), 'pipelines');

// Webhook secret — read from settings or env
function getWebhookSecret(): string {
	return process.env.SOUL_HUB_WEBHOOK_SECRET || config.webhookSecret || '';
}

/**
 * POST /api/pipelines/trigger — trigger a pipeline run via webhook
 *
 * Headers:
 *   Authorization: Bearer <secret>
 *
 * Body:
 *   { "name": "pipeline-name", "inputs": { ... } }
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = getWebhookSecret();

	// Auth check — require secret if one is configured
	if (secret) {
		const auth = request.headers.get('authorization');
		const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
		if (token !== secret) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
	}

	const body = await request.json();
	const { name, inputs } = body as { name: string; inputs?: Record<string, string | number> };

	if (!name) {
		return json({ error: 'Missing pipeline name' }, { status: 400 });
	}

	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');

	// Validate pipeline exists
	try {
		await parsePipeline(yamlPath);
	} catch {
		return json({ error: `Pipeline "${name}" not found` }, { status: 404 });
	}

	// Check concurrency before starting
	const { getActivePipelines } = await import('$lib/pipeline/index.js');
	if (getActivePipelines().has(name)) {
		return json({ error: `Pipeline "${name}" is already running` }, { status: 409 });
	}

	// Fire-and-forget — don't await (pipeline may have approval gates)
	const runId = crypto.randomUUID().slice(0, 8);
	executeScheduledRun(name, yamlPath, 'webhook', inputs);

	return json({ runId, status: 'started' });
};
