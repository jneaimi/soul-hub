import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { listInstalledBlocks } from '$lib/pipeline/block-installer.js';

const CATALOG_DIR = config.resolved.catalogDir;
const PIPELINES_DIR = resolve(dirname(CATALOG_DIR), 'pipelines');

/** GET /api/blocks/installed/[pipeline] — returns installed blocks for a pipeline */
export const GET: RequestHandler = async ({ params }) => {
	const { pipeline } = params;

	try {
		const pipelineDir = resolve(PIPELINES_DIR, pipeline);
		const blocks = await listInstalledBlocks(pipelineDir);
		return json({ blocks });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
