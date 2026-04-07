import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getBlock } from '$lib/pipeline/block-registry.js';

/** GET /api/blocks/catalog/[name] — returns single block detail + full BLOCK.md body */
export const GET: RequestHandler = async ({ params }) => {
	const { name } = params;

	try {
		const block = await getBlock(name);
		if (!block) {
			return json({ error: `Block "${name}" not found in catalog` }, { status: 404 });
		}
		return json({ block });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
