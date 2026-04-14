import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname, basename } from 'node:path';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { config } from '$lib/config.js';
import { listPipelines, findChainReferences, parsePipeline, parseChain, aggregateChainEnvVars, getSavedInputs } from '$lib/pipeline/index.js';
import { listInstalledBlocks } from '$lib/pipeline/block-installer.js';
import { getBlockConfigSchema, type BlockManifest, type ConfigField } from '$lib/pipeline/block.js';
import { getActivePipelines, cleanupPipelineState } from '$lib/pipeline/scheduler.js';
import { access, mkdir } from 'node:fs/promises';

// Pipelines directory is alongside catalog in the soul-hub root
const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');


/** GET /api/pipelines — list available pipelines */
export const GET: RequestHandler = async ({ url }) => {
	const detail = url.searchParams.get('name');

	// If a specific pipeline is requested, return full spec + output path
	if (detail) {
		const pipelineYamlPath = resolve(PIPELINES_DIR, detail, 'pipeline.yaml');
		const chainYamlPath = resolve(PIPELINES_DIR, detail, 'chain.yaml');

		// Detect: pipeline or chain?
		let isPipeline = true;
		try { await access(pipelineYamlPath); } catch { isPipeline = false; }

		if (isPipeline) {
			try {
				const spec = await parsePipeline(pipelineYamlPath);
				const outputDir = resolve(PIPELINES_DIR, detail, 'output');
				const saved = getSavedInputs(spec.name);
				const envStatus = (spec.env || []).map(e => ({
					name: e.name,
					description: e.description,
					required: e.required !== false,
					set: !!process.env[e.name],
				}));

				const pipelineDir = resolve(PIPELINES_DIR, detail);
				let installedBlocks: BlockManifest[] = [];
				let configSchema: ConfigField[] = [];
				try {
					installedBlocks = await listInstalledBlocks(pipelineDir);
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

				const configFiles = (spec.shared_config || []).map(c => ({
					name: c.name,
					description: c.description || '',
					path: c.file,
					columns: c.columns || [],
				}));

				let fixRequests: { name: string; content: string }[] = [];
				try {
					const fixDir = resolve(pipelineDir, '.fix-requests');
					const files = await readdir(fixDir);
					for (const f of files) {
						if (f.endsWith('.md')) {
							const content = await readFile(resolve(fixDir, f), 'utf-8');
							fixRequests.push({ name: f, content });
						}
					}
				} catch { /* no fix requests dir */ }

				return json({ pipeline: spec, type: 'pipeline', path: pipelineYamlPath, outputDir, savedInputs: saved, envStatus, installedBlocks, configSchema, config_files: configFiles, fixRequests });
			} catch (err) {
				return json({ error: (err as Error).message }, { status: 404 });
			}
		} else {
			// Chain detail
			try {
				const chainSpec = await parseChain(chainYamlPath);
				const saved = getSavedInputs(chainSpec.name);
				const nodeDetails = await Promise.all(chainSpec.nodes.map(async (node) => {
					try {
						const spec = await parsePipeline(resolve(PIPELINES_DIR, node.pipeline, 'pipeline.yaml'));
						return { id: node.id, pipeline: node.pipeline, description: spec.description, stepCount: spec.steps.length, inputs: spec.inputs };
					} catch { return { id: node.id, pipeline: node.pipeline, description: '', stepCount: 0, inputs: [] }; }
				}));
				const envStatus = await aggregateChainEnvVars(chainSpec, PIPELINES_DIR);

				return json({ chain: chainSpec, type: 'chain', path: chainYamlPath, nodeDetails, envStatus, savedInputs: saved });
			} catch (err) {
				return json({ error: (err as Error).message }, { status: 404 });
			}
		}
	}

	// List all pipelines
	const pipelines = await listPipelines(PIPELINES_DIR);
	return json({ pipelines });
};

/** DELETE /api/pipelines — archive or permanently delete a pipeline */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { name, permanent } = body as { name?: string; permanent?: boolean };

	if (!name || typeof name !== 'string') {
		return json({ error: 'Missing pipeline name' }, { status: 400 });
	}

	// Sanitize: prevent path traversal
	if (name.includes('/') || name.includes('..') || name.startsWith('.') || name.startsWith('_')) {
		return json({ error: 'Invalid pipeline name' }, { status: 400 });
	}

	const pipelineDir = resolve(PIPELINES_DIR, name);

	// Verify the pipeline exists
	try {
		await access(pipelineDir);
	} catch {
		return json({ error: `Pipeline "${name}" not found` }, { status: 404 });
	}

	// Block if actively running
	const active = getActivePipelines();
	if (active.has(name)) {
		return json({ error: `Pipeline "${name}" is currently running. Stop it first.` }, { status: 409 });
	}

	// Check chain references
	const chainRefs = await findChainReferences(name);

	// Clean up scheduler state (cron jobs, watchers, saved inputs, automation config)
	await cleanupPipelineState(name);

	if (permanent) {
		// Permanent delete
		await rm(pipelineDir, { recursive: true, force: true });
	} else {
		// Archive: move to _archive/
		const archiveDir = resolve(PIPELINES_DIR, '_archive');
		await mkdir(archiveDir, { recursive: true });
		const archiveDest = resolve(archiveDir, name);
		// If already archived with same name, append timestamp
		try {
			await access(archiveDest);
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			await rename(pipelineDir, resolve(archiveDir, `${name}_${ts}`));
		} catch {
			await rename(pipelineDir, archiveDest);
		}
	}

	return json({
		ok: true,
		action: permanent ? 'deleted' : 'archived',
		chainWarnings: chainRefs.length > 0
			? `This pipeline is referenced by chain(s): ${chainRefs.join(', ')}. Those chains will fail until the reference is removed.`
			: undefined,
	});
};
