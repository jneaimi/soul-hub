import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '$lib/config.js';

const DEV_DIR = config.resolved.devDir;
const BRAIN_PROJECTS = config.resolved.brainProjects;
const BRAIN_AREAS = config.resolved.brainAreas;

interface Project {
	name: string;
	devPath: string | null;
	brainPath: string | null;
	lastModified: string;
	type: 'development' | 'content' | 'research' | 'media' | 'operations' | 'unknown';
	hasGit: boolean;
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

async function getLastModified(path: string): Promise<Date> {
	try {
		const s = await stat(path);
		return s.mtime;
	} catch {
		return new Date(0);
	}
}

function inferType(name: string, hasDevDir: boolean): Project['type'] {
	const lower = name.toLowerCase();
	if (lower.includes('signal-forge') || lower.includes('research')) return 'research';
	if (lower.includes('content') || lower.includes('social-media')) return 'content';
	if (lower.includes('media') || lower.includes('design')) return 'media';
	if (lower.includes('claude-soul') || lower.includes('ops') || lower.includes('devops')) return 'operations';
	if (hasDevDir) return 'development';
	return 'unknown';
}

/** GET /api/projects — scan filesystem for projects */
export const GET: RequestHandler = async () => {
	const projectMap = new Map<string, Partial<Project>>();

	// Scan ~/dev/
	if (await dirExists(DEV_DIR)) {
		const entries = await readdir(DEV_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const devPath = join(DEV_DIR, entry.name);
			const hasGit = await dirExists(join(devPath, '.git'));
			const mtime = await getLastModified(devPath);
			projectMap.set(entry.name, {
				name: entry.name,
				devPath,
				hasGit,
				lastModified: mtime.toISOString(),
			});
		}
	}

	// Scan ~/SecondBrain/01-projects/
	if (await dirExists(BRAIN_PROJECTS)) {
		const entries = await readdir(BRAIN_PROJECTS, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const brainPath = join(BRAIN_PROJECTS, entry.name);
			const existing = projectMap.get(entry.name) || { name: entry.name };
			existing.brainPath = brainPath;
			if (!existing.lastModified) {
				const mtime = await getLastModified(brainPath);
				existing.lastModified = mtime.toISOString();
			}
			projectMap.set(entry.name, existing);
		}
	}

	// Scan ~/SecondBrain/02-areas/
	if (await dirExists(BRAIN_AREAS)) {
		const entries = await readdir(BRAIN_AREAS, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const brainPath = join(BRAIN_AREAS, entry.name);
			const existing = projectMap.get(entry.name) || { name: entry.name };
			if (!existing.brainPath) {
				existing.brainPath = brainPath;
			}
			if (!existing.lastModified) {
				const mtime = await getLastModified(brainPath);
				existing.lastModified = mtime.toISOString();
			}
			projectMap.set(entry.name, existing);
		}
	}

	// Finalize
	const projects: Project[] = Array.from(projectMap.values()).map((p) => ({
		name: p.name!,
		devPath: p.devPath || null,
		brainPath: p.brainPath || null,
		lastModified: p.lastModified || new Date(0).toISOString(),
		type: inferType(p.name!, !!p.devPath),
		hasGit: p.hasGit || false,
	}));

	projects.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

	return json({ projects });
};
