import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { executeScheduledRun, parsePipeline, getActivePipelines, isTriggerEnabled, getTriggerMethod } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.marketplaceDir), 'pipelines');

function getWebhookSecret(): string {
	return process.env.SOUL_HUB_WEBHOOK_SECRET || config.webhookSecret || '';
}

async function handleTrigger(request: Request, url: URL): Promise<Response> {
	const secret = getWebhookSecret();

	// Auth check
	if (secret) {
		const auth = request.headers.get('authorization');
		const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
		if (token !== secret) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}
	}

	// Get pipeline name
	let name = '';
	let inputs: Record<string, string | number> | undefined;

	if (request.method === 'GET') {
		name = url.searchParams.get('name') || '';
	} else {
		const body = await request.json().catch(() => ({}));
		name = body.name || '';
		inputs = body.inputs;
	}

	if (!name) return json({ error: 'Missing pipeline name' }, { status: 400 });

	// Check if trigger is enabled for this pipeline
	if (!isTriggerEnabled(name)) {
		return json({ error: `Trigger is disabled for "${name}"` }, { status: 403 });
	}

	// Check if method matches configured method
	const allowedMethod = getTriggerMethod(name);
	if (request.method !== allowedMethod) {
		return json({ error: `Pipeline "${name}" only accepts ${allowedMethod} triggers` }, { status: 405 });
	}

	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');
	try {
		await parsePipeline(yamlPath);
	} catch {
		return json({ error: `Pipeline "${name}" not found` }, { status: 404 });
	}

	if (getActivePipelines().has(name)) {
		return json({ error: `Pipeline "${name}" is already running` }, { status: 409 });
	}

	executeScheduledRun(name, yamlPath, 'webhook', inputs);
	return json({ status: 'started' });
}

export const GET: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
export const POST: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
export const PUT: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
