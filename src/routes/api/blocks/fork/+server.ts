import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { forkBlock } from '$lib/pipeline/block-installer.js';

const CATALOG_DIR = config.resolved.catalogDir;
const PIPELINES_DIR = resolve(dirname(CATALOG_DIR), 'pipelines');

/** POST /api/blocks/fork — fork a catalog block into a pipeline with a new name */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { pipelineName, blockName, newName } = body as {
		pipelineName?: string;
		blockName?: string;
		newName?: string;
	};

	if (!pipelineName || !blockName || !newName) {
		return json({ error: 'Missing pipelineName, blockName, or newName' }, { status: 400 });
	}

	try {
		const pipelineDir = resolve(PIPELINES_DIR, pipelineName);
		const manifest = await forkBlock(CATALOG_DIR, pipelineDir, blockName, newName);
		return json({ ok: true, block: manifest });
	} catch (err) {
		const message = (err as Error).message;
		const status = message.includes('not found')
			? 404
			: message.includes('already exists')
				? 409
				: message.includes('Invalid block name')
					? 400
					: 500;
		return json({ error: message }, { status });
	}
};
