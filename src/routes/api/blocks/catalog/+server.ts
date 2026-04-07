import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { scanCatalog } from '$lib/pipeline/block-registry.js';

/** GET /api/blocks/catalog — returns all blocks from catalog/ with manifests */
export const GET: RequestHandler = async () => {
	try {
		const blocks = await scanCatalog();
		return json({ blocks });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
