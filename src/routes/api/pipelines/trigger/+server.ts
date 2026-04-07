import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { executeScheduledRun, parsePipeline, getActivePipelines, isTriggerEnabled, getTriggerSecret } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

/**
 * Trigger endpoint: /api/pipelines/trigger?name=<pipeline>
 *
 * Accepts any HTTP method. Pipeline name from query param.
 * Auth: ?token=<secret> or Authorization: Bearer <secret>
 * Optional JSON body with { inputs: { ... } } to override defaults.
 */
async function handleTrigger(request: Request, url: URL): Promise<Response> {
	const name = url.searchParams.get('name') || '';
	if (!name) return json({ error: 'Missing ?name= parameter' }, { status: 400 });

	// Check if trigger is enabled
	if (!isTriggerEnabled(name)) {
		return json({ error: `Trigger is disabled for "${name}"` }, { status: 403 });
	}

	// Auth: check token from query param or Authorization header
	const secret = getTriggerSecret(name);
	if (secret) {
		const queryToken = url.searchParams.get('token') || '';
		const headerToken = request.headers.get('authorization')?.replace('Bearer ', '') || '';
		if (queryToken !== secret && headerToken !== secret) {
			return json({ error: 'Unauthorized — invalid or missing token' }, { status: 401 });
		}
	}

	// Validate pipeline exists
	const yamlPath = resolve(PIPELINES_DIR, name, 'pipeline.yaml');
	try {
		await parsePipeline(yamlPath);
	} catch {
		return json({ error: `Pipeline "${name}" not found` }, { status: 404 });
	}

	// Concurrency check
	if (getActivePipelines().has(name)) {
		return json({ error: `Pipeline "${name}" is already running` }, { status: 409 });
	}

	// Optional inputs from body (only if request has a body)
	let inputs: Record<string, string | number> | undefined;
	if (request.body) {
		try {
			const body = await request.json();
			inputs = body.inputs;
		} catch { /* no body or invalid JSON — use defaults */ }
	}

	executeScheduledRun(name, yamlPath, 'webhook', inputs);
	return json({ status: 'started', pipeline: name });
}

export const GET: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
export const POST: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
export const PUT: RequestHandler = async ({ request, url }) => handleTrigger(request, url);
