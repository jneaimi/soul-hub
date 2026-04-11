import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/templates — Available templates */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const templates = await engine.getTemplates();
		return json({ templates });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
