import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { config } from '$lib/config.js';
import { parsePipeline } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

/** GET /api/config-file?pipeline=X&file=Y — read JSON config rows + columns from pipeline spec */
export const GET: RequestHandler = async ({ url }) => {
	const pipeline = url.searchParams.get('pipeline');
	const file = url.searchParams.get('file');

	if (!pipeline || !file) {
		return json({ error: 'pipeline and file params required' }, { status: 400 });
	}

	// Security: path must stay under pipelines/
	const resolved = resolve(PIPELINES_DIR, pipeline, file);
	if (!resolved.startsWith(PIPELINES_DIR)) {
		return json({ error: 'path traversal blocked' }, { status: 403 });
	}

	// Read columns from pipeline.yaml shared_config
	let columns: unknown[] = [];
	try {
		const spec = await parsePipeline(join(PIPELINES_DIR, pipeline, 'pipeline.yaml'));
		const cfg = (spec.shared_config || []).find(c => c.file === file);
		if (cfg?.columns) columns = cfg.columns;
	} catch { /* pipeline parse failed — proceed without columns */ }

	try {
		const content = await readFile(resolved, 'utf-8');
		const rows = JSON.parse(content);
		return json({ rows: Array.isArray(rows) ? rows : [], columns });
	} catch {
		return json({ rows: [], columns });
	}
};

/** POST /api/config-file — write JSON rows to config file */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { pipeline, file, rows } = body;

	if (!pipeline || !file || !Array.isArray(rows)) {
		return json({ error: 'pipeline, file, and rows[] required' }, { status: 400 });
	}

	const resolved = resolve(PIPELINES_DIR, pipeline, file);
	if (!resolved.startsWith(PIPELINES_DIR)) {
		return json({ error: 'path traversal blocked' }, { status: 403 });
	}

	await mkdir(dirname(resolved), { recursive: true });
	await writeFile(resolved, JSON.stringify(rows, null, 2) + '\n', 'utf-8');

	return json({ ok: true, count: rows.length });
};
