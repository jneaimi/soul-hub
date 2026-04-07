import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { installBlock, uninstallBlock } from '$lib/pipeline/block-installer.js';

const CATALOG_DIR = config.resolved.catalogDir;
const PIPELINES_DIR = resolve(dirname(CATALOG_DIR), 'pipelines');

/** POST /api/blocks/install — install a block from catalog into a pipeline */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { pipelineName, blockName } = body as { pipelineName?: string; blockName?: string };

	if (!pipelineName || !blockName) {
		return json({ error: 'Missing pipelineName or blockName' }, { status: 400 });
	}

	try {
		const pipelineDir = resolve(PIPELINES_DIR, pipelineName);
		const manifest = await installBlock(CATALOG_DIR, pipelineDir, blockName);
		return json({ ok: true, block: manifest });
	} catch (err) {
		const message = (err as Error).message;
		const status = message.includes('not found') ? 404 : message.includes('already installed') ? 409 : 500;
		return json({ error: message }, { status });
	}
};

/** DELETE /api/blocks/install — uninstall a block from a pipeline */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { pipelineName, blockName } = body as { pipelineName?: string; blockName?: string };

	if (!pipelineName || !blockName) {
		return json({ error: 'Missing pipelineName or blockName' }, { status: 400 });
	}

	try {
		const pipelineDir = resolve(PIPELINES_DIR, pipelineName);
		await uninstallBlock(pipelineDir, blockName);
		return json({ ok: true });
	} catch (err) {
		const message = (err as Error).message;
		const status = message.includes('not installed') ? 404 : 500;
		return json({ error: message }, { status });
	}
};
