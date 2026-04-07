import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { listPipelines, parsePipeline, getSavedInputs } from '$lib/pipeline/index.js';
import { listInstalledBlocks } from '$lib/pipeline/block-installer.js';
import { getBlockConfigSchema, type BlockManifest, type ConfigField } from '$lib/pipeline/block.js';

// Pipelines directory is alongside catalog in the soul-hub root
const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

// Default output root in Second Brain
const OUTPUT_ROOT = resolve(config.resolved.brainDir, '02-areas', 'pipelines');

/** GET /api/pipelines — list available pipelines */
export const GET: RequestHandler = async ({ url }) => {
	const detail = url.searchParams.get('name');

	// If a specific pipeline is requested, return full spec + output path
	if (detail) {
		try {
			const yamlPath = resolve(PIPELINES_DIR, detail, 'pipeline.yaml');
			const spec = await parsePipeline(yamlPath);
			const outputDir = resolve(OUTPUT_ROOT, detail);
			const saved = getSavedInputs(spec.name);
			// Check env var status for validation UI
			const envStatus = (spec.env || []).map(e => ({
				name: e.name,
				description: e.description,
				required: e.required !== false,
				set: !!process.env[e.name],
			}));

			// Block info: installed blocks + catalog + merged config schema
			const pipelineDir = resolve(PIPELINES_DIR, detail);
			let installedBlocks: BlockManifest[] = [];
			let configSchema: ConfigField[] = [];
			try {
				installedBlocks = await listInstalledBlocks(pipelineDir);
				// Merge config fields from all installed blocks referenced in steps
				for (const step of spec.steps) {
					if (!step.block) continue;
					const block = installedBlocks.find(b => b.name === step.block);
					if (block) {
						const fields = getBlockConfigSchema(block).map(f => ({
							...f,
							_stepId: step.id,
							_blockName: block.name,
						}));
						configSchema.push(...(fields as ConfigField[]));
					}
				}
			} catch {
				// Block features degrade gracefully if blocks/ doesn't exist yet
			}

			// Map shared_config to config_files for the UI
			const configFiles = (spec.shared_config || []).map(c => ({
				name: c.name,
				description: c.description || '',
				path: c.file,
			}));

			return json({ pipeline: spec, path: yamlPath, outputDir, savedInputs: saved, envStatus, installedBlocks, configSchema, config_files: configFiles });
		} catch (err) {
			return json({ error: (err as Error).message }, { status: 404 });
		}
	}

	// List all pipelines
	const pipelines = await listPipelines(PIPELINES_DIR);
	return json({ pipelines, outputRoot: OUTPUT_ROOT });
};
