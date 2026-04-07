import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBlockManifest } from '$lib/pipeline/block.js';

/** POST /api/blocks/validate — validate a block directory has a valid BLOCK.md */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as { blockDir?: string; sharedConfig?: { name?: string; file?: string }[] };
	const { blockDir } = body;

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
		const warnings: string[] = [];

		if (!manifest.name) errors.push('Missing name field');
		if (!manifest.type) errors.push('Missing type field');
		if (!manifest.description) errors.push('Missing description field');
		if (manifest.type === 'script' && !manifest.runtime) {
			errors.push('Script blocks must declare a runtime');
		}

		// Validate outputs section
		if (!manifest.outputs || manifest.outputs.length === 0) {
			warnings.push('Missing outputs section — consumers won\'t know what this block produces');
		} else {
			for (const output of manifest.outputs) {
				if (!output.type) {
					errors.push(`Output "${output.name}": missing type`);
				}
				// File-type outputs need a format
				if (output.type === 'file' && !(output as unknown as Record<string, unknown>).format) {
					warnings.push(`Output "${output.name}": file type should declare a format (json, csv, markdown, etc.)`);
				}
			}
		}

		// Validate shared_config references use .json
		if (body.sharedConfig) {
			const configs = body.sharedConfig as { name?: string; file?: string }[];
			for (const cfg of configs) {
				if (cfg.file && !cfg.file.endsWith('.json')) {
					errors.push(`Shared config "${cfg.name || cfg.file}": config files must have .json extension`);
				}
			}
		}

		// Warn on missing optional fields
		if (!manifest.version) warnings.push('Missing version field');
		if (!manifest.env || manifest.env.length === 0) {
			warnings.push('No env vars declared — block may silently fail if it needs API keys');
		}

		return json({
			valid: errors.length === 0,
			errors,
			warnings,
			manifest: errors.length === 0 ? manifest : undefined,
		});
	} catch (err) {
		return json({ valid: false, errors: [(err as Error).message], warnings: [] });
	}
};
