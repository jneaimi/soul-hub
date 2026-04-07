/**
 * Block installer — copies blocks between catalog and pipeline directories.
 *
 * Operations:
 * - install: catalog/{type}/{name}/ → pipelines/{pipeline}/blocks/{name}/
 * - uninstall: removes from pipelines/{pipeline}/blocks/{name}/
 * - list: reads installed blocks from pipelines/{pipeline}/blocks/
 */

import { cp, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBlockManifest } from './block.js';
import type { BlockManifest } from './block.js';

/** Locate a block in the catalog by name, searching all type dirs */
async function findBlockInCatalog(
	catalogDir: string,
	blockName: string,
): Promise<{ dir: string; type: string } | null> {
	const typeDirs = ['scripts', 'agents', 'skills', 'mcp', 'pipelines'];

	for (const typeDir of typeDirs) {
		const candidate = join(catalogDir, typeDir, blockName);
		try {
			const s = await stat(candidate);
			if (s.isDirectory()) {
				return { dir: candidate, type: typeDir };
			}
		} catch { /* not here */ }
	}

	return null;
}

/**
 * Install a block from the catalog into a pipeline's blocks/ directory.
 * Copies the entire block directory (BLOCK.md, scripts, configs, etc.).
 *
 * @returns The parsed manifest of the installed block.
 * @throws If the block is not found in the catalog or is already installed.
 */
export async function installBlock(
	catalogDir: string,
	pipelineDir: string,
	blockName: string,
	options?: { force?: boolean },
): Promise<BlockManifest> {
	const found = await findBlockInCatalog(catalogDir, blockName);
	if (!found) {
		throw new Error(`Block "${blockName}" not found in catalog at ${catalogDir}`);
	}

	const destDir = join(pipelineDir, 'blocks', blockName);

	// Check if already installed (unless force)
	if (!options?.force) {
		try {
			const s = await stat(destDir);
			if (s.isDirectory()) {
				throw new Error(`Block "${blockName}" is already installed in ${pipelineDir}. Use force to overwrite.`);
			}
		} catch (err) {
			// ENOENT is expected (not installed yet) — rethrow anything else
			if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw err;
			}
			// If it's our own "already installed" error, rethrow
			if (err instanceof Error && err.message.includes('already installed')) {
				throw err;
			}
		}
	}

	// Copy block directory recursively
	await cp(found.dir, destDir, { recursive: true });

	// Parse and return the manifest to confirm it's valid
	return parseBlockManifest(destDir);
}

/**
 * Uninstall a block from a pipeline's blocks/ directory.
 *
 * @throws If the block is not installed.
 */
export async function uninstallBlock(
	pipelineDir: string,
	blockName: string,
): Promise<void> {
	const blockDir = join(pipelineDir, 'blocks', blockName);

	try {
		const s = await stat(blockDir);
		if (!s.isDirectory()) {
			throw new Error(`Block "${blockName}" is not a directory in ${pipelineDir}/blocks/`);
		}
	} catch (err) {
		if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Block "${blockName}" is not installed in ${pipelineDir}`);
		}
		throw err;
	}

	await rm(blockDir, { recursive: true });
}

/**
 * List all installed blocks in a pipeline's blocks/ directory.
 * Reads each block's BLOCK.md manifest.
 *
 * @returns Array of BlockManifest for each installed block.
 */
export async function listInstalledBlocks(
	pipelineDir: string,
): Promise<BlockManifest[]> {
	const blocksDir = join(pipelineDir, 'blocks');
	const manifests: BlockManifest[] = [];

	let names: string[];
	try {
		const entries = await readdir(blocksDir, { withFileTypes: true });
		names = entries.filter(e => e.isDirectory()).map(e => String(e.name));
	} catch {
		return []; // no blocks/ dir = no blocks installed
	}

	for (const name of names) {
		if (name.startsWith('.') || name.startsWith('_')) continue;
		try {
			const manifest = await parseBlockManifest(join(blocksDir, name));
			manifests.push(manifest);
		} catch {
			// Skip blocks with invalid/missing BLOCK.md
		}
	}

	return manifests;
}

/** Kebab-case name validation: lowercase, starts with letter, allows hyphens and digits */
const VALID_BLOCK_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Fork a block from the catalog into a pipeline's blocks/ directory with a new name.
 * Copies all files, then patches BLOCK.md to use the new name.
 *
 * @returns The parsed manifest of the forked block (with new name).
 * @throws If the source block is not found, the name is invalid, or the target already exists.
 */
export async function forkBlock(
	catalogDir: string,
	pipelineDir: string,
	blockName: string,
	newName: string,
): Promise<BlockManifest> {
	// Validate new name
	if (!newName || !VALID_BLOCK_NAME.test(newName)) {
		throw new Error(`Invalid block name "${newName}": must match /^[a-z][a-z0-9-]*$/`);
	}

	// Find source block in catalog
	const found = await findBlockInCatalog(catalogDir, blockName);
	if (!found) {
		throw new Error(`Block "${blockName}" not found in catalog at ${catalogDir}`);
	}

	// Check target doesn't already exist
	const destDir = join(pipelineDir, 'blocks', newName);
	try {
		const s = await stat(destDir);
		if (s.isDirectory()) {
			throw new Error(`Block "${newName}" already exists in ${pipelineDir}/blocks/`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes('already exists')) throw err;
		// ENOENT is expected
	}

	// Copy block directory
	await cp(found.dir, destDir, { recursive: true });

	// Patch BLOCK.md: replace the name field in frontmatter
	const blockMdPath = join(destDir, 'BLOCK.md');
	const raw = await readFile(blockMdPath, 'utf-8');
	const patched = raw.replace(/^(name:\s*).+$/m, `$1${newName}`);
	await writeFile(blockMdPath, patched, 'utf-8');

	return parseBlockManifest(destDir);
}
