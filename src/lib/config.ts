import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChannelsSettings } from './channels/types.js';

const HOME = homedir();

export interface SoulHubConfig {
	terminal: {
		fontSize: number;
		cols: number;
		rows: number;
		cursorBlink: boolean;
	};
	interface: {
		defaultPanel: 'code' | 'closed';
		panelWidth: number;
	};
	paths: {
		devDir: string;
		vaultDir: string;
		catalogDir: string;
		claudeBinary: string;
	};
	server: {
		port: number;
	};
	channels: ChannelsSettings;
	proxy: {
		enabled: boolean;
		allowedPortRange: [number, number];
		blockedPorts: number[];
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
		vaultDir: '~/vault',
		catalogDir: '~/dev/soul-hub/catalog',
		claudeBinary: '~/.local/bin/claude',
	},
	server: {
		port: 5173,
	},
	channels: {
		telegram: {
			enabled: false,
			label: 'Telegram',
			defaultFor: ['send'],
		},
	},
	proxy: {
		enabled: true,
		allowedPortRange: [1024, 9999],
		blockedPorts: [2400],
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
	// Look for settings.json in: 1) project root (process.cwd), 2) env var, 3) legacy path
	const candidates = [
		resolve(process.cwd(), 'settings.json'),
		process.env.SOUL_HUB_SETTINGS || '',
		resolve(HOME, '.soul-hub', 'settings.json'),
	].filter(Boolean);

	for (const settingsPath of candidates) {
		try {
			const raw = readFileSync(settingsPath, 'utf-8');
			const parsed = JSON.parse(raw);
			return merge(DEFAULTS, parsed);
		} catch {
			continue;
		}
	}
	return DEFAULTS;
}

// Load once at startup — config changes require restart for path/server values
const _config = loadSettings();

/** Resolved config with ~ expanded to absolute paths */
export const config: SoulHubConfig & { resolved: { devDir: string; vaultDir: string; catalogDir: string; claudeBinary: string } } = {
	..._config,
	resolved: {
		devDir: expandPath(_config.paths.devDir),
		vaultDir: expandPath(_config.paths.vaultDir),
		catalogDir: expandPath(_config.paths.catalogDir),
		claudeBinary: expandPath(_config.paths.claudeBinary),
	},
};

export { DEFAULTS };
