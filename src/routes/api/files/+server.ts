import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const MIME_TYPES: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
	gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
	ico: 'image/x-icon', bmp: 'image/bmp', pdf: 'application/pdf',
};

import { config } from '$lib/config.js';

// Only allow reading within these roots
const ALLOWED_ROOTS = [
	config.resolved.devDir,
	config.resolved.brainDir,
	'/tmp/pipeline-runs',
];

// Skip these directories when listing
const EXCLUDED_DIRS = new Set([
	'node_modules', '.git', '.svelte-kit', '.next', '__pycache__',
	'.venv', 'venv', '.cache', '.turbo', 'dist', 'build', '.output',
	'.nuxt', '.vercel', 'coverage', '.pids', 'logs',
]);

function isPathAllowed(targetPath: string): boolean {
	const resolved = resolve(targetPath);
	return ALLOWED_ROOTS.some((root) => resolved.startsWith(root + '/') || resolved === root);
}

export const GET: RequestHandler = async ({ url }) => {
	const targetPath = url.searchParams.get('path');
	const action = url.searchParams.get('action') || 'list';
	const file = url.searchParams.get('file');

	if (!targetPath) {
		return json({ error: 'Missing path parameter' }, { status: 400 });
	}

	const resolved = resolve(targetPath);

	if (!isPathAllowed(resolved)) {
		return json({ error: 'Access denied' }, { status: 403 });
	}

	// Serve binary files (images, PDFs) with correct content-type
	if (action === 'raw' && file) {
		const filePath = resolve(resolved, file);
		if (!isPathAllowed(filePath)) {
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(filePath);
			if (s.size > 10_485_760) {
				return json({ error: 'File too large (>10MB)', size: s.size }, { status: 413 });
			}
			const ext = file.split('.').pop()?.toLowerCase() || '';
			const mime = MIME_TYPES[ext] || 'application/octet-stream';
			const buffer = await readFile(filePath);
			return new Response(buffer, {
				headers: {
					'Content-Type': mime,
					'Content-Length': String(s.size),
					'Cache-Control': 'private, max-age=60',
				},
			});
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	if (action === 'read' && file) {
		const filePath = resolve(resolved, file);
		if (!isPathAllowed(filePath)) {
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(filePath);
			// Limit file reads to 1MB
			if (s.size > 1_048_576) {
				return json({ error: 'File too large (>1MB)', size: s.size }, { status: 413 });
			}
			const content = await readFile(filePath, 'utf-8');
			return json({ content, size: s.size, path: filePath });
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	// Default: list directory
	try {
		const entries = await readdir(resolved, { withFileTypes: true });
		const result = [];

		for (const entry of entries) {
			// Skip hidden files (except .claude) and excluded dirs
			if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
			if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

			const entryPath = join(resolved, entry.name);
			try {
				const s = await stat(entryPath);
				result.push({
					name: entry.name,
					type: entry.isDirectory() ? 'dir' : 'file',
					size: entry.isFile() ? s.size : undefined,
				});
			} catch {
				// Skip entries we can't stat (broken symlinks etc)
				continue;
			}
		}

		// Sort: dirs first, then alphabetical
		result.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return json({ entries: result, path: resolved });
	} catch {
		return json({ error: 'Directory not found' }, { status: 404 });
	}
};
