/**
 * Block catalog registry — scans catalog/ for BLOCK.md manifests.
 *
 * Stub: Agent 1 will flesh out the full implementation.
 * Phase C API routes import from here.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '$lib/config.js';
import { parseBlockManifest, type BlockManifest } from './block.js';

const CATALOG_DIR = config.resolved.catalogDir;

/** Category subdirectories in catalog/ that contain blocks */
const BLOCK_CATEGORIES = ['scripts', 'agents', 'skills', 'mcp', 'pipelines'];

/**
 * Scan the entire catalog and return all block manifests.
 */
export async function scanCatalog(): Promise<BlockManifest[]> {
	const manifests: BlockManifest[] = [];

	for (const category of BLOCK_CATEGORIES) {
		const categoryDir = join(CATALOG_DIR, category);
		let entries: string[];
		try {
			entries = await readdir(categoryDir);
		} catch {
			continue; // category dir doesn't exist yet
		}

		for (const entry of entries) {
			if (entry.startsWith('_') || entry.startsWith('.')) continue;
			try {
				const manifest = await parseBlockManifest(join(categoryDir, entry));
				manifests.push(manifest);
			} catch {
				// Skip directories without valid BLOCK.md
			}
		}
	}

	return manifests;
}

/**
 * Get a single block from the catalog by name.
 * Searches all category subdirectories.
 */
export async function getBlock(name: string): Promise<BlockManifest | null> {
	for (const category of BLOCK_CATEGORIES) {
		const blockDir = join(CATALOG_DIR, category, name);
		try {
			const manifest = await parseBlockManifest(blockDir);
			return manifest;
		} catch {
			continue;
		}
	}
	return null;
}
