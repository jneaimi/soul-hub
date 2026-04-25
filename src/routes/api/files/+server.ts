import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isPathAllowed, findRootForPath } from '$lib/explorer-roots.js';
import { recordAccess } from '$lib/file-audit.js';

const MIME_TYPES: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
	gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
	ico: 'image/x-icon', bmp: 'image/bmp', pdf: 'application/pdf',
};

// Skip these directories when listing — universally noisy / never useful in a file browser
const EXCLUDED_DIRS = new Set([
	'node_modules', '.git', '.svelte-kit', '.next', '__pycache__',
	'.venv', 'venv', '.cache', '.turbo', 'dist', 'build', '.output',
	'.nuxt', '.vercel', 'coverage', '.pids', 'logs',
]);

/**
 * Resolve a path through the filesystem (following symlinks) so the final
 * allow-check operates on the canonical path. Returns null if the path
 * doesn't exist — callers should treat that as a 404.
 */
function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function getClientIp(headers: Headers): string {
	return (
		headers.get('cf-connecting-ip') ||
		headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		headers.get('x-real-ip') ||
		'unknown'
	);
}

export const GET: RequestHandler = async ({ url, request }) => {
	const targetPath = url.searchParams.get('path');
	const action = url.searchParams.get('action') || 'list';
	const file = url.searchParams.get('file');
	const ip = getClientIp(request.headers);

	if (!targetPath) {
		return json({ error: 'Missing path parameter' }, { status: 400 });
	}

	const resolved = resolve(targetPath);
	const realDir = safeRealpath(resolved);
	if (!realDir) {
		return json({ error: 'Directory not found' }, { status: 404 });
	}

	const dirCheck = isPathAllowed(realDir);
	if (!dirCheck.allowed) {
		return json({ error: 'Access denied', reason: dirCheck.reason }, { status: 403 });
	}

	// Lightweight existence check — returns {exists, size} without reading content
	if (action === 'stat' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			return json({ exists: false, error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			return json({ error: 'Access denied' }, { status: 403 });
		}
		try {
			const s = await stat(realFile);
			return json({ exists: true, size: s.size });
		} catch {
			return json({ exists: false, error: 'File not found' }, { status: 404 });
		}
	}

	// Serve binary files (images, PDFs) with correct content-type.
	// Supports ?disposition=attachment to force a download; default is inline.
	if (action === 'raw' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: filePath, status: 'not_found' });
			return json({ error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'denied' });
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(realFile);
			if (s.size > 10_485_760) {
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'too_large', bytes: s.size });
				return json({ error: 'File too large (>10MB)', size: s.size }, { status: 413 });
			}
			const ext = file.split('.').pop()?.toLowerCase() || '';
			const mime = MIME_TYPES[ext] || 'application/octet-stream';
			const buffer = await readFile(realFile);
			// RFC 5987 encoding so non-ASCII filenames round-trip correctly
			const dispositionType = url.searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
			const asciiFallback = file.replace(/[^\x20-\x7E]/g, '_');
			const encodedName = encodeURIComponent(file);
			const contentDisposition = `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'ok', bytes: s.size });
			return new Response(buffer, {
				headers: {
					'Content-Type': mime,
					'Content-Length': String(s.size),
					'Cache-Control': 'private, max-age=60',
					'Content-Disposition': contentDisposition,
				},
			});
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	if (action === 'read' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: filePath, status: 'not_found' });
			return json({ error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'denied' });
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(realFile);
			// Limit file reads to 1MB
			if (s.size > 1_048_576) {
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'too_large', bytes: s.size });
				return json({ error: 'File too large (>1MB)', size: s.size }, { status: 413 });
			}
			const content = await readFile(realFile, 'utf-8');
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'ok', bytes: s.size });
			return json({ content, size: s.size, path: realFile });
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	// Default: list directory.
	// Hidden files (`.dotfiles`) are filtered out unless the containing root opts in
	// via showHidden. `.claude/` stays visible regardless because the agent system
	// stores user-relevant config there.
	try {
		const entries = await readdir(realDir, { withFileTypes: true });
		const result = [];
		const root = findRootForPath(realDir);
		const showHidden = root?.showHidden ?? false;

		for (const entry of entries) {
			if (entry.name.startsWith('.') && entry.name !== '.claude' && !showHidden) continue;
			if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

			const entryPath = join(realDir, entry.name);
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

		return json({ entries: result, path: realDir });
	} catch {
		return json({ error: 'Directory not found' }, { status: 404 });
	}
};
