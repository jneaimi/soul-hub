import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigSchema, type SoulHubConfig } from './config.schema.js';
import { soulHubSettingsPath } from './paths.js';

const HOME = homedir();

export type { SoulHubConfig } from './config.schema.js';

/** Expand ~ to $HOME in path strings */
function expandPath(p: string): string {
	if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
	if (p === '~') return HOME;
	return resolve(p);
}

function loadSettings(): SoulHubConfig {
	// Look for settings.json in: 1) explicit env override, 2) ~/.soul-hub/settings.json,
	// 3) legacy repo-root location (kept as a fallback during migration).
	const candidates = [
		process.env.SOUL_HUB_SETTINGS || '',
		soulHubSettingsPath(),
		resolve(process.cwd(), 'settings.json'),
	].filter(Boolean);

	let parsed: unknown = {};
	let source: string | null = null;
	for (const settingsPath of candidates) {
		try {
			parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			source = settingsPath;
			break;
		} catch {
			continue;
		}
	}

	const result = ConfigSchema.safeParse(parsed);
	if (!result.success) {
		console.error(`[config] settings.json validation failed (source: ${source ?? 'defaults'}):`);
		for (const issue of result.error.issues) {
			console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
		}
		console.error('[config] Falling back to defaults.');
		return ConfigSchema.parse({});
	}
	return result.data;
}

function buildResolved(parsed: SoulHubConfig) {
	return {
		devDir: expandPath(parsed.paths.devDir),
		vaultDir: expandPath(parsed.paths.vaultDir),
		catalogDir: expandPath(parsed.paths.catalogDir),
		claudeBinary: expandPath(parsed.paths.claudeBinary),
	};
}

// Loaded at startup; mutated in place by `reloadConfig()` when settings.json
// changes. Callers that read `config.<field>` per access (e.g. the WhatsApp
// adapter's `readChannelConfig`) automatically see the fresh value. Modules
// that cached a sub-reference at init (e.g. `config.resolved.vaultDir` baked
// into the vault watcher path) still need a process restart for those slots.
const _config = loadSettings();

/** Resolved config with ~ expanded to absolute paths */
export const config: SoulHubConfig & { resolved: { devDir: string; vaultDir: string; catalogDir: string; claudeBinary: string } } = {
	..._config,
	resolved: buildResolved(_config),
};

/** Re-read settings.json and replace every top-level field of the exported
 *  `config` object in place. Keeps the import reference stable so live
 *  consumers like `import { config } from '$lib/config.js'` see fresh values
 *  on next property read.
 *
 *  Safe to call from request handlers — re-uses Zod validation; if the file
 *  is corrupt we keep the old config and log instead of crashing. */
export function reloadConfig(): { ok: boolean; error?: string } {
	let fresh: SoulHubConfig;
	try {
		fresh = loadSettings();
	} catch (err) {
		const msg = (err as Error).message;
		console.warn('[config] reloadConfig failed, keeping previous values:', msg);
		return { ok: false, error: msg };
	}

	for (const key of Object.keys(config) as Array<keyof typeof config>) {
		if (key === 'resolved') continue;
		delete (config as Record<string, unknown>)[key];
	}
	Object.assign(config, fresh);
	config.resolved = buildResolved(fresh);

	console.log('[config] Reloaded from settings.json');
	return { ok: true };
}

/** Default config (parsed from empty input) — exposed for callers that need a baseline. */
export const DEFAULTS: SoulHubConfig = ConfigSchema.parse({});
