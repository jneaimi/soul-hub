import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from '$lib/config.js';

const MARKETPLACE_DIR = config.resolved.marketplaceDir;

export const POST: RequestHandler = async ({ request }) => {
	const { type, name, projectPath } = await request.json();

	if (!type || !name || !projectPath) {
		return json({ error: 'Missing type, name, or projectPath' }, { status: 400 });
	}

	// Validate project path is under ~/dev/
	const resolved = resolve(projectPath);
	if (!resolved.startsWith(config.resolved.devDir + '/')) {
		return json({ error: 'Invalid project path' }, { status: 403 });
	}

	try {
		if (type === 'skill') {
			const src = resolve(MARKETPLACE_DIR, 'skills', name);
			const dest = resolve(resolved, '.claude', 'skills', name);
			await mkdir(resolve(resolved, '.claude', 'skills'), { recursive: true });
			await cp(src, dest, { recursive: true });
			return json({ ok: true, installed: dest });
		}

		if (type === 'agent') {
			const src = resolve(MARKETPLACE_DIR, 'agents', `${name}.md`);
			const dest = resolve(resolved, '.claude', 'agents', `${name}.md`);
			await mkdir(resolve(resolved, '.claude', 'agents'), { recursive: true });
			await cp(src, dest);
			return json({ ok: true, installed: dest });
		}

		return json({ error: 'Invalid type — must be skill or agent' }, { status: 400 });
	} catch (err) {
		return json({ error: `Install failed: ${(err as Error).message}` }, { status: 500 });
	}
};
