import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from '$lib/config.js';

const REGISTRY_PATH = resolve(config.resolved.marketplaceDir, 'registry.json');

export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(REGISTRY_PATH, 'utf-8');
		const registry = JSON.parse(raw);
		return json(registry);
	} catch (err) {
		return json(
			{ error: 'Failed to load marketplace registry', skills: [], agents: [] },
			{ status: 500 }
		);
	}
};
