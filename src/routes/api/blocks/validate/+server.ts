import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBlockManifest } from '$lib/pipeline/block.js';

/** POST /api/blocks/validate — validate a block directory has a valid BLOCK.md */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { blockDir } = body as { blockDir?: string };

	if (!blockDir) {
		return json({ error: 'Missing blockDir' }, { status: 400 });
	}

	// Check directory exists
	try {
		const s = await stat(blockDir);
		if (!s.isDirectory()) {
			return json({ valid: false, errors: [`${blockDir} is not a directory`] });
		}
	} catch {
		return json({ valid: false, errors: [`Directory not found: ${blockDir}`] });
	}

	// Check BLOCK.md exists
	try {
		await stat(join(blockDir, 'BLOCK.md'));
	} catch {
		return json({ valid: false, errors: ['Missing BLOCK.md'] });
	}

	// Parse and validate manifest
	try {
		const manifest = await parseBlockManifest(blockDir);

		const errors: string[] = [];
		if (!manifest.name) errors.push('Missing name field');
		if (!manifest.type) errors.push('Missing type field');
		if (!manifest.description) errors.push('Missing description field');
		if (manifest.type === 'script' && !manifest.runtime) {
			errors.push('Script blocks must declare a runtime');
		}

		return json({
			valid: errors.length === 0,
			errors,
			manifest: errors.length === 0 ? manifest : undefined,
		});
	} catch (err) {
		return json({ valid: false, errors: [(err as Error).message] });
	}
};
