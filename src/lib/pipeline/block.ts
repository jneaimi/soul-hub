/**
 * BLOCK.md manifest parser and validator.
 *
 * Reads YAML frontmatter from BLOCK.md files, validates config against
 * the declared schema, and extracts config fields for UI rendering.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────

export type ConfigFieldType = 'text' | 'number' | 'select' | 'multiselect' | 'toggle' | 'file' | 'textarea';
export type BlockType = 'script' | 'agent' | 'skill' | 'mcp' | 'pipeline';

export interface ConfigField {
	name: string;
	type: ConfigFieldType;
	label?: string;
	description?: string;
	default?: unknown;
	min?: number;
	max?: number;
	options?: string[];
	required?: boolean;
}

export interface BlockInput {
	name: string;
	type: string;
	format?: string;
	description?: string;
	default?: string;
}

export interface BlockOutput {
	name: string;
	type: string;
	table?: string;
	description?: string;
}

export interface BlockEnvVar {
	name: string;
	description?: string;
	required?: boolean;
}

export interface BlockData {
	requires?: string[];
	produces?: string[];
	database?: string;
}

export interface BlockManifest {
	name: string;
	type: BlockType;
	runtime?: string;
	description: string;
	author?: string;
	version?: string;
	inputs?: BlockInput[];
	outputs?: BlockOutput[];
	config?: ConfigField[];
	env?: BlockEnvVar[];
	data?: BlockData;
	/** Raw markdown body (everything after the frontmatter) */
	body?: string;
}

// ── YAML frontmatter parser (minimal, no dependency) ──

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: raw };

	const yamlBlock = match[1];
	const body = match[2];
	const meta = parseSimpleYaml(yamlBlock);
	return { meta, body };
}

/**
 * Minimal YAML parser — handles scalars, arrays, and nested objects
 * used in BLOCK.md manifests. Not a full YAML parser.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = text.split('\n');
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const keyMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);

		if (!keyMatch) { i++; continue; }

		const key = keyMatch[1];
		const rawValue = keyMatch[2].trim();

		// Inline array: [a, b, c]
		if (rawValue.startsWith('[')) {
			result[key] = parseInlineArray(rawValue);
			i++;
			continue;
		}

		// Scalar value on same line
		if (rawValue && !rawValue.startsWith('-')) {
			result[key] = coerce(rawValue);
			i++;
			continue;
		}

		// Block array or nested objects (indented lines following)
		if (!rawValue) {
			const items = collectIndented(lines, i + 1);
			if (items.lines.length > 0 && items.lines[0].trimStart().startsWith('- name:')) {
				result[key] = parseObjectArray(items.lines);
			} else if (items.lines.length > 0 && items.lines[0].trimStart().startsWith('-')) {
				result[key] = items.lines.map(l => coerce(l.replace(/^\s*-\s*/, '')));
			} else if (items.lines.length > 0) {
				result[key] = parseSimpleYaml(items.lines.map(l => l.replace(/^  /, '')).join('\n'));
			}
			i = items.nextIndex;
			continue;
		}

		i++;
	}

	return result;
}

function collectIndented(lines: string[], start: number): { lines: string[]; nextIndex: number } {
	const collected: string[] = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '' || /^\s+/.test(line)) {
			if (line.trim() !== '') collected.push(line);
			i++;
		} else {
			break;
		}
	}
	return { lines: collected, nextIndex: i };
}

function parseObjectArray(lines: string[]): Record<string, unknown>[] {
	const objects: Record<string, unknown>[] = [];
	let current: Record<string, unknown> | null = null;

	for (const line of lines) {
		const itemStart = line.match(/^\s*-\s+(\w+)\s*:\s*(.*)/);
		if (itemStart) {
			if (current) objects.push(current);
			current = { [itemStart[1]]: coerce(itemStart[2].trim()) };
			continue;
		}
		const prop = line.match(/^\s+(\w+)\s*:\s*(.*)/);
		if (prop && current) {
			const val = prop[2].trim();
			if (val.startsWith('[')) {
				current[prop[1]] = parseInlineArray(val);
			} else {
				current[prop[1]] = coerce(val);
			}
		}
	}
	if (current) objects.push(current);
	return objects;
}

function parseInlineArray(raw: string): unknown[] {
	const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
	return inner.split(',').map(s => coerce(s.trim()));
}

function coerce(val: string): unknown {
	if (val === 'true') return true;
	if (val === 'false') return false;
	if (val === '') return '';
	if (/^-?\d+$/.test(val)) return parseInt(val, 10);
	if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
	// Strip quotes
	return val.replace(/^["']|["']$/g, '');
}

// ── Public API ─────────────────────────────────────────

/**
 * Parse BLOCK.md from a block directory and return a typed manifest.
 */
export async function parseBlockManifest(blockDir: string): Promise<BlockManifest> {
	const blockPath = join(blockDir, 'BLOCK.md');
	const raw = await readFile(blockPath, 'utf-8');
	const { meta, body } = parseFrontmatter(raw);

	if (!meta.name || !meta.type) {
		throw new Error(`Invalid BLOCK.md in ${blockDir}: missing name or type`);
	}

	return {
		name: meta.name as string,
		type: meta.type as BlockType,
		runtime: meta.runtime as string | undefined,
		description: (meta.description as string) || '',
		author: meta.author as string | undefined,
		version: meta.version as string | undefined,
		inputs: (meta.inputs as BlockInput[]) || undefined,
		outputs: (meta.outputs as BlockOutput[]) || undefined,
		config: (meta.config as ConfigField[]) || undefined,
		env: (meta.env as BlockEnvVar[]) || undefined,
		data: meta.data as BlockData | undefined,
		body,
	};
}

/**
 * Validate a config object against the manifest's declared config schema.
 */
export function validateBlockConfig(
	manifest: BlockManifest,
	config: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	const fields = manifest.config || [];

	for (const field of fields) {
		const value = config[field.name];
		const hasValue = value !== undefined && value !== null && value !== '';

		// Required check (fields without a default are implicitly required)
		if (!hasValue && field.default === undefined && field.required !== false) {
			errors.push(`Missing required config field: ${field.name}`);
			continue;
		}

		if (!hasValue) continue;

		switch (field.type) {
			case 'number': {
				const num = typeof value === 'number' ? value : Number(value);
				if (isNaN(num)) {
					errors.push(`${field.name}: expected a number, got "${value}"`);
				} else {
					if (field.min !== undefined && num < field.min)
						errors.push(`${field.name}: ${num} is below minimum ${field.min}`);
					if (field.max !== undefined && num > field.max)
						errors.push(`${field.name}: ${num} exceeds maximum ${field.max}`);
				}
				break;
			}
			case 'select': {
				if (field.options && !field.options.includes(String(value))) {
					errors.push(`${field.name}: "${value}" is not in options [${field.options.join(', ')}]`);
				}
				break;
			}
			case 'multiselect': {
				const arr = Array.isArray(value) ? value : [value];
				for (const item of arr) {
					if (field.options && !field.options.includes(String(item))) {
						errors.push(`${field.name}: "${item}" is not in options [${field.options.join(', ')}]`);
					}
				}
				break;
			}
			case 'toggle': {
				if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
					errors.push(`${field.name}: expected boolean, got "${value}"`);
				}
				break;
			}
			// text, file, textarea — no additional validation beyond presence
		}
	}

	return { ok: errors.length === 0, errors };
}

/**
 * Extract config fields from a manifest for UI rendering.
 */
export function getBlockConfigSchema(manifest: BlockManifest): ConfigField[] {
	return (manifest.config || []).map(field => ({
		name: field.name,
		type: field.type,
		label: field.label || field.name,
		description: field.description,
		default: field.default,
		min: field.min,
		max: field.max,
		options: field.options,
		required: field.required,
	}));
}
