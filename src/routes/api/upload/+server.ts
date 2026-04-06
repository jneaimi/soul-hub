import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';

import { config } from '$lib/config.js';

const DEV_DIR = config.resolved.devDir;

function sanitizeFilename(raw: string): string | null {
	// Keep original filename but strip path traversal
	const name = basename(raw).replace(/[^\w.\-]/g, '_');
	if (!name || name.startsWith('.')) return null;
	return name;
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/** POST /api/upload — upload files to a project directory */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const project = formData.get('project') as string;
	const subfolder = (formData.get('subfolder') as string) || '';

	if (!project || /[/\\.]/.test(project)) {
		return json({ error: 'Invalid project name' }, { status: 400 });
	}

	const projectDir = join(DEV_DIR, project);
	if (!(await dirExists(projectDir))) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	// Determine target directory
	let targetDir = projectDir;
	if (subfolder) {
		// Sanitize subfolder — no path traversal
		const cleanSub = subfolder.replace(/\.\./g, '').replace(/^\//, '');
		targetDir = join(projectDir, cleanSub);
		await mkdir(targetDir, { recursive: true });
	}

	const files = formData.getAll('files') as File[];
	if (files.length === 0) {
		return json({ error: 'No files provided' }, { status: 400 });
	}

	const results: { name: string; path: string; size: number }[] = [];

	for (const file of files) {
		const safeName = sanitizeFilename(file.name);
		if (!safeName) continue;

		const filePath = join(targetDir, safeName);
		const buffer = Buffer.from(await file.arrayBuffer());
		await writeFile(filePath, buffer);

		results.push({
			name: safeName,
			path: filePath,
			size: buffer.length,
		});
	}

	return json({ uploaded: results });
};
