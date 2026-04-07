import type { PageServerLoad } from './$types';
import { resolve, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
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
	if (forkParam) {
		try {
			const block = await getBlock(forkParam);
			if (block) {
				forkName = forkParam;
				forkBlockContent = block.body || block.description || '';
			}
		} catch {
			// block not found — page will show error banner
		}
	}

	// Pipeline edit flow: load pipeline.yaml and installed blocks
	let pipelineYaml: string | null = null;
	let pipelineBlocks: BlockManifest[] = [];
	if (pipelineParam) {
		const pipelineDir = join(PIPELINES_DIR, pipelineParam);
		try {
			pipelineYaml = await readFile(join(pipelineDir, 'pipeline.yaml'), 'utf-8');
			pipelineBlocks = await listInstalledBlocks(pipelineDir);
		} catch {
			// pipeline not found — page will show error banner
		}
	}

	// Troubleshoot flow: load block context for failed step
	let troubleshootContext: {
		stepId: string;
		error: string;
		blockName: string;
		blockContent: string;
		scriptContent: string;
	} | null = null;

	const troubleshootParam = url.searchParams.get('troubleshoot');
	const errorParam = url.searchParams.get('error');
	if (troubleshootParam && pipelineParam && pipelineYaml) {
		try {
			const parsed = parseYaml(pipelineYaml) as { steps?: { id: string; block?: string }[] };
			const step = parsed.steps?.find((s) => s.id === troubleshootParam);
			const blockName = step?.block || troubleshootParam;
			const pipelineDir = join(PIPELINES_DIR, pipelineParam);
			const blockDir = join(pipelineDir, 'blocks', blockName);

			let blockContent = '';
			try {
				blockContent = await readFile(join(blockDir, 'BLOCK.md'), 'utf-8');
			} catch { /* block may not exist */ }

			let scriptContent = '';
			for (const file of ['run.py', 'agent.md']) {
				try {
					scriptContent = await readFile(join(blockDir, file), 'utf-8');
					break;
				} catch { /* try next */ }
			}

			troubleshootContext = {
				stepId: troubleshootParam,
				error: errorParam || 'Unknown error',
				blockName,
				blockContent,
				scriptContent,
			};
		} catch { /* yaml parse failed — skip */ }
	}

	return {
		// ALWAYS use builderDir — guard hooks in _builder/.claude/ only load from this cwd
		cwd: builderDir,
		catalogBlocks,
		forkBlockContent,
		forkName,
		pipelineYaml,
		pipelineBlocks,
		pipelineName: pipelineParam,
		troubleshootContext,
	};
};
