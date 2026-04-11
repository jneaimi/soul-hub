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

	// Chain edit flow: load chain.yaml
	let chainYaml: string | null = null;
	const chainParam = url.searchParams.get('chain');
	let chainName: string | null = chainParam;
	if (chainParam) {
		try {
			chainYaml = await readFile(join(PIPELINES_DIR, chainParam, 'chain.yaml'), 'utf-8');
		} catch {
			chainName = null;
		}
	}

	// Chain troubleshoot flow: troubleshoot a node within a chain
	// URL: ?chain=cafe-data-cleanse&troubleshoot=validate-schema&error=...
	// The troubleshoot param is the node ID, and the node's pipeline name is in chain.yaml
	if (troubleshootParam && chainParam && chainYaml && !troubleshootContext) {
		try {
			const chainParsed = parseYaml(chainYaml) as { nodes?: { id: string; pipeline: string }[] };
			const node = chainParsed.nodes?.find((n) => n.id === troubleshootParam);
			if (node) {
				const nodePipelineDir = join(PIPELINES_DIR, node.pipeline);
				let nodePipelineYaml = '';
				try {
					nodePipelineYaml = await readFile(join(nodePipelineDir, 'pipeline.yaml'), 'utf-8');
				} catch { /* pipeline may not exist */ }

				// Find the failed step within the node's pipeline (if error mentions a step)
				let failedBlockName = '';
				let failedBlockContent = '';
				let failedScriptContent = '';
				if (nodePipelineYaml) {
					const nodeParsed = parseYaml(nodePipelineYaml) as { steps?: { id: string; block?: string }[] };
					// Try to find a failed step from the error message
					for (const step of nodeParsed.steps || []) {
						if (step.block) {
							const blockDir = join(nodePipelineDir, 'blocks', step.block);
							try {
								failedBlockContent = await readFile(join(blockDir, 'BLOCK.md'), 'utf-8');
								failedBlockName = step.block;
								for (const file of ['run.py', 'agent.md', 'run.sh', 'run.js']) {
									try {
										failedScriptContent = await readFile(join(blockDir, file), 'utf-8');
										break;
									} catch { /* try next */ }
								}
								break; // Take the first block — the error context will help Claude find the right one
							} catch { /* block dir doesn't exist */ }
						}
					}
				}

				troubleshootContext = {
					stepId: troubleshootParam,
					error: errorParam || 'Unknown error',
					blockName: failedBlockName || node.pipeline,
					blockContent: failedBlockContent,
					scriptContent: failedScriptContent,
				};

				// Also load pipeline yaml for context
				if (!pipelineYaml && nodePipelineYaml) {
					pipelineYaml = nodePipelineYaml;
				}
			}
		} catch { /* chain parse failed */ }
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
		chainYaml,
		chainName,
	};
};
