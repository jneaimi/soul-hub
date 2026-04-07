import type { PageServerLoad } from './$types';
import { resolve, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { config } from '$lib/config.js';
import { scanCatalog } from '$lib/pipeline/block-registry.js';
import { listInstalledBlocks } from '$lib/pipeline/block-installer.js';
import { getBlock } from '$lib/pipeline/block-registry.js';
import type { BlockManifest } from '$lib/pipeline/block.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

export const load: PageServerLoad = async ({ url }) => {
	const builderDir = resolve(PIPELINES_DIR, '_builder');
	const forkParam = url.searchParams.get('fork');
	const pipelineParam = url.searchParams.get('pipeline');

	// Always scan the catalog
	let catalogBlocks: BlockManifest[] = [];
	try {
		catalogBlocks = await scanCatalog();
	} catch {
		// catalog unavailable — continue with empty
	}

	// Fork flow: load source block's BLOCK.md content
	let forkBlockContent: string | null = null;
	let forkName: string | null = null;
	let forkBlockType: string | null = null;
	if (forkParam) {
		try {
			const block = await getBlock(forkParam);
			if (block) {
				forkName = forkParam;
				forkBlockContent = block.body || block.description || '';
				forkBlockType = block.type;
			}
		} catch {
			// block not found — page will show error banner
		}
	}

	// Pipeline edit flow: load pipeline.yaml and installed blocks
	let pipelineYaml: string | null = null;
	let pipelineBlocks: BlockManifest[] = [];
	let pipelineCwd: string | null = null;
	if (pipelineParam) {
		const pipelineDir = join(PIPELINES_DIR, pipelineParam);
		try {
			pipelineYaml = await readFile(join(pipelineDir, 'pipeline.yaml'), 'utf-8');
			pipelineBlocks = await listInstalledBlocks(pipelineDir);
			pipelineCwd = pipelineDir;
		} catch {
			// pipeline not found — page will show error banner
		}
	}

	return {
		cwd: pipelineCwd || builderDir,
		catalogBlocks,
		forkBlockContent,
		forkBlockType,
		forkName,
		pipelineYaml,
		pipelineBlocks,
		pipelineName: pipelineParam,
	};
};
