import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { listPipelines, parsePipeline } from '$lib/pipeline/index.js';

// Pipelines directory is alongside marketplace in the soul-hub root
const PIPELINES_DIR = resolve(dirname(config.resolved.marketplaceDir), 'pipelines');

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
			return json({ pipeline: spec, path: yamlPath, outputDir });
		} catch (err) {
			return json({ error: (err as Error).message }, { status: 404 });
		}
	}

	// List all pipelines
	const pipelines = await listPipelines(PIPELINES_DIR);
	return json({ pipelines, outputRoot: OUTPUT_ROOT });
};
