/**
 * Global secrets layer — platform-level secrets stored in .data/secrets.env
 *
 * Secrets are loaded at startup and merged into process.env.
 * The API allows reading (masked) and writing secrets from the UI.
 * Actual values never leave the server — the UI only sees masked versions.
 *
 * File format: standard .env (KEY=value, one per line, # comments)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const HOME = process.env.HOME || '';
const SECRETS_PATH = resolve(HOME, 'dev', 'soul-hub', '.data', 'secrets.env');

/** Parse a .env file into key-value pairs */
function parseEnv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx === -1) continue;
		const key = trimmed.substring(0, eqIdx).trim();
		let value = trimmed.substring(eqIdx + 1).trim();
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) result[key] = value;
	}
	return result;
}

/** Serialize key-value pairs to .env format */
function serializeEnv(secrets: Record<string, string>): string {
	const lines = ['# Soul Hub platform secrets', '# Managed via Settings > Channels', ''];
	for (const [key, value] of Object.entries(secrets)) {
		// Quote values that contain spaces or special chars
		if (value.includes(' ') || value.includes('#') || value.includes('"')) {
			lines.push(`${key}="${value.replace(/"/g, '\\"')}"`);
		} else {
			lines.push(`${key}=${value}`);
		}
	}
	lines.push(''); // trailing newline
	return lines.join('\n');
}

/** Load secrets from .data/secrets.env and merge into process.env */
export function loadSecrets(): Record<string, string> {
	if (!existsSync(SECRETS_PATH)) return {};
	try {
		const content = readFileSync(SECRETS_PATH, 'utf-8');
		const secrets = parseEnv(content);
		// Merge into process.env — secrets.env values override shell env
		// This allows UI-configured values to take precedence
		for (const [key, value] of Object.entries(secrets)) {
			process.env[key] = value;
		}
		return secrets;
	} catch {
		return {};
	}
}

/** Get all secrets as masked entries (for UI display) */
export function getMaskedSecrets(): { key: string; set: boolean; source: 'platform' | 'shell' }[] {
	const platformSecrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	// Collect all known platform secret keys
	const allKeys = new Set(Object.keys(platformSecrets));

	return Array.from(allKeys).map((key) => ({
		key,
		set: !!process.env[key],
		source: key in platformSecrets ? 'platform' as const : 'shell' as const,
	}));
}

/** Check if a specific env var is set (from any source) */
export function isEnvSet(key: string): boolean {
	return !!process.env[key];
}

/** Set a secret — writes to .data/secrets.env and updates process.env */
export function setSecret(key: string, value: string): void {
	// Validate key format
	if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
		throw new Error(`Invalid secret key: "${key}". Use UPPER_SNAKE_CASE.`);
	}

	// Load existing secrets
	const secrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	// Update
	secrets[key] = value;

	// Ensure .data/ directory exists
	const dir = dirname(SECRETS_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	// Write back
	writeFileSync(SECRETS_PATH, serializeEnv(secrets), 'utf-8');

	// Update process.env immediately (no restart needed)
	process.env[key] = value;
}

/** Remove a secret — deletes from .data/secrets.env and process.env */
export function removeSecret(key: string): void {
	const secrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	delete secrets[key];
	delete process.env[key];

	writeFileSync(SECRETS_PATH, serializeEnv(secrets), 'utf-8');
}

/** Get the raw value of a secret (server-side only — never expose to client) */
export function getSecretValue(key: string): string | undefined {
	return process.env[key];
}

/** Sync known env vars from process.env (shell) into .data/secrets.env.
 *  Only imports keys that exist in process.env but not in secrets.env.
 *  Returns the count of newly synced keys. */
export function syncFromShell(keys: string[]): number {
	const existing = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	let synced = 0;
	for (const key of keys) {
		// Only sync if the key exists in process.env and is not already in secrets.env
		if (process.env[key] && !(key in existing)) {
			existing[key] = process.env[key]!;
			synced++;
		}
	}

	if (synced > 0) {
		const dir = dirname(SECRETS_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(SECRETS_PATH, serializeEnv(existing), 'utf-8');
	}

	return synced;
}

// Load secrets on module import (server startup)
loadSecrets();
