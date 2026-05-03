import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { soulHubSettingsPath } from '$lib/paths.js';
import { ConfigSchema } from '$lib/config.schema.js';
import { reloadConfig } from '$lib/config.js';

const SETTINGS_PATH = soulHubSettingsPath();
const PartialConfigSchema = ConfigSchema.partial();

/** GET /api/settings — read current settings */
export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(SETTINGS_PATH, 'utf-8');
		return json(JSON.parse(raw));
	} catch {
		return json({ error: 'Settings file not found' }, { status: 404 });
	}
};

/** POST /api/settings — validate and save settings */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		const result = PartialConfigSchema.safeParse(body);
		if (!result.success) {
			return json(
				{
					error: 'Validation failed',
					issues: result.error.issues.map((i) => ({
						path: i.path.join('.'),
						message: i.message,
					})),
				},
				{ status: 400 },
			);
		}

		// Read existing to merge with the validated patch
		let existing: Record<string, unknown> = {};
		try {
			const raw = await readFile(SETTINGS_PATH, 'utf-8');
			existing = JSON.parse(raw);
		} catch {
			/* start fresh */
		}

		const merged = { ...existing, ...result.data };

		await mkdir(dirname(SETTINGS_PATH), { recursive: true });
		await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

		// Hot-reload the in-memory config so live consumers (channel adapters,
		// route registries, etc.) see the new values without a restart. Path
		// fields are mutated too but downstream watchers typically cached
		// absolute paths at startup — those still need a restart.
		const reload = reloadConfig();

		return json({
			ok: true,
			settings: merged,
			reloaded: reload.ok,
			reloadError: reload.error,
		});
	} catch (err) {
		return json({ error: `Failed to save: ${(err as Error).message}` }, { status: 500 });
	}
};
