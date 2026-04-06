import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME = process.env.HOME || '';

export interface SoulHubConfig {
	terminal: {
		fontSize: number;
		cols: number;
		rows: number;
		cursorBlink: boolean;
	};
	interface: {
		defaultPanel: 'code' | 'brain' | 'closed';
		panelWidth: number;
	};
	paths: {
		devDir: string;
		brainDir: string;
		marketplaceDir: string;
		claudeBinary: string;
	};
	server: {
		port: number;
	};
}

const DEFAULTS: SoulHubConfig = {
	terminal: {
		fontSize: 13,
		cols: 120,
		rows: 40,
		cursorBlink: true,
	},
	interface: {
		defaultPanel: 'code',
		panelWidth: 260,
	},
	paths: {
		devDir: '~/dev',
		brainDir: '~/SecondBrain',
		marketplaceDir: '~/dev/soul-hub/marketplace',
		claudeBinary: '~/.local/bin/claude',
	},
	server: {
		port: 5173,
	},
};

/** Expand ~ to $HOME in path strings */
function expandPath(p: string): string {
	if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
	if (p === '~') return HOME;
	return resolve(p);
}

/** Deep merge b into a (b wins) */
function merge<T extends Record<string, any>>(a: T, b: Partial<T>): T {
	const result = { ...a };
	for (const key of Object.keys(b) as (keyof T)[]) {
		const val = b[key];
		if (val !== undefined && val !== null && typeof val === 'object' && !Array.isArray(val)) {
			result[key] = merge(a[key] as any, val as any);
		} else if (val !== undefined) {
			result[key] = val as T[keyof T];
		}
	}
	return result;
}

function loadSettings(): SoulHubConfig {
	const settingsPath = resolve(HOME, 'dev', 'soul-hub', 'settings.json');
	try {
		const raw = readFileSync(settingsPath, 'utf-8');
		const parsed = JSON.parse(raw);
		return merge(DEFAULTS, parsed);
	} catch {
		return DEFAULTS;
	}
}

// Load once at startup — config changes require restart for path/server values
const _config = loadSettings();

/** Resolved config with ~ expanded to absolute paths */
export const config: SoulHubConfig & { resolved: { devDir: string; brainDir: string; brainProjects: string; brainAreas: string; marketplaceDir: string; claudeBinary: string } } = {
	..._config,
	resolved: {
		devDir: expandPath(_config.paths.devDir),
		brainDir: expandPath(_config.paths.brainDir),
		brainProjects: resolve(expandPath(_config.paths.brainDir), '01-projects'),
		brainAreas: resolve(expandPath(_config.paths.brainDir), '02-areas'),
		marketplaceDir: expandPath(_config.paths.marketplaceDir),
		claudeBinary: expandPath(_config.paths.claudeBinary),
	},
};

export { DEFAULTS };
