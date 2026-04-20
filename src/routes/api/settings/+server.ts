import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SETTINGS_PATH = resolve(process.cwd(), 'settings.json');

/** GET /api/settings — read current settings */
export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(SETTINGS_PATH, 'utf-8');
		return json(JSON.parse(raw));
	} catch {
		return json({ error: 'Settings file not found' }, { status: 404 });
	}
};

/** POST /api/settings — save settings */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		// Validate structure — only allow known keys
		const allowed = ['terminal', 'interface', 'paths', 'server', 'channels'];
		const filtered: Record<string, unknown> = {};
		for (const key of allowed) {
			if (body[key] !== undefined) filtered[key] = body[key];
		}

		// Read existing to merge
		let existing: Record<string, unknown> = {};
		try {
			const raw = await readFile(SETTINGS_PATH, 'utf-8');
			existing = JSON.parse(raw);
		} catch { /* start fresh */ }

		const merged = { ...existing, ...filtered };

		await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
		return json({ ok: true, settings: merged });
	} catch (err) {
		return json({ error: `Failed to save: ${(err as Error).message}` }, { status: 500 });
	}
};
