/** GET /api/vault/projects — list every folder under <vault>/projects/ with
 *  a frontmatter rollup (ADR count by status, last activity, open count,
 *  upcoming falsifier dates).
 *
 *  Per ADR-037 Phase 1.5. Read-only; the matching `/projects` UI uses this
 *  as its primary data source. The vault engine indexes notes (frontmatter,
 *  content, links) but does not natively enumerate project folders, so this
 *  endpoint scans the directory then calls `engine.getNotes({ project })`
 *  per slug to build the rollup. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';

const PROJECT_ZONE = 'projects';

type StatusCounts = {
	proposed: number;
	accepted: number;
	shipped: number;
	rejected: number;
	parked: number;
	other: number;
};

interface ProjectRollup {
	slug: string;
	adrCount: number;
	noteCount: number;
	statusCounts: StatusCounts;
	openCount: number;
	lastActivity: number | null;
	upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
	hasIndex: boolean;
}

function emptyStatusCounts(): StatusCounts {
	return { proposed: 0, accepted: 0, shipped: 0, rejected: 0, parked: 0, other: 0 };
}

function bucketStatus(raw: unknown): keyof StatusCounts {
	const s = String(raw ?? '').toLowerCase();
	if (s === 'proposed') return 'proposed';
	if (s === 'accepted') return 'accepted';
	if (s.startsWith('shipped') || s === 'phase-1-shipped' || s === 'phase-1+4-lite-shipped') return 'shipped';
	if (s === 'rejected') return 'rejected';
	if (s === 'parked') return 'parked';
	return 'other';
}

function daysBetween(iso: string): number | null {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.round((t - Date.now()) / 86_400_000);
}

/** Coerce a YAML date|string value to ISO YYYY-MM-DD. YAML parses
 *  `falsifier_date: 2026-06-30` as a Date object; we want the string. */
function asIsoDate(raw: unknown): string | null {
	if (typeof raw === 'string') return raw.trim() || null;
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
		return raw.toISOString().slice(0, 10);
	}
	return null;
}

export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const projectsDir = resolve(engine.vaultDir, PROJECT_ZONE);
	let entries: string[];
	try {
		entries = await readdir(projectsDir);
	} catch (err) {
		return json(
			{ error: `Cannot read projects dir: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}

	// Optional ?slug=foo,bar — return only those folders (used by detail view)
	const filterParam = url.searchParams.get('slug');
	const filterSet = filterParam ? new Set(filterParam.split(',').map((s) => s.trim())) : null;

	const rollups: ProjectRollup[] = [];

	for (const slug of entries) {
		if (slug.startsWith('.') || slug.startsWith('_')) continue;
		if (filterSet && !filterSet.has(slug)) continue;

		const abs = resolve(projectsDir, slug);
		try {
			const s = await stat(abs);
			if (!s.isDirectory()) continue;
		} catch {
			continue;
		}

		// All notes whose frontmatter `project: <slug>` matches. Falls back to
		// nothing if the project has no notes with that field — most projects
		// in the vault DO use the `project:` frontmatter, but a few legacy
		// folders don't, in which case the rollup will under-report.
		const notes = engine.getNotes({ project: slug, limit: 500 });

		const counts = emptyStatusCounts();
		let adrCount = 0;
		let lastActivity: number | null = null;
		let hasIndex = false;
		const upcomingFalsifiers: ProjectRollup['upcomingFalsifiers'] = [];

		for (const note of notes) {
			// SearchResult is a thin shape — we need full meta for status/falsifier.
			// `engine.getNote(path)` returns the indexed note with meta.
			const full = engine.getNote(note.path);
			if (!full) continue;

			if (note.path.endsWith('/index.md') || note.path.endsWith(`/${slug}/index.md`)) {
				hasIndex = true;
			}

			if (full.mtime && (!lastActivity || full.mtime > lastActivity)) {
				lastActivity = full.mtime;
			}

			if (full.meta.type === 'decision') {
				adrCount++;
				const bucket = bucketStatus(full.meta.status);
				counts[bucket]++;

				const falsifier = asIsoDate(full.meta.falsifier_date) ?? asIsoDate(full.meta.falsifierDate);
				if (falsifier) {
					const days = daysBetween(falsifier);
					if (days !== null && days >= -1 && days <= 60) {
						upcomingFalsifiers.push({ path: note.path, date: falsifier, daysAway: days });
					}
				}
			}
		}

		upcomingFalsifiers.sort((a, b) => a.daysAway - b.daysAway);

		rollups.push({
			slug,
			adrCount,
			noteCount: notes.length,
			statusCounts: counts,
			openCount: counts.proposed,
			lastActivity,
			upcomingFalsifiers,
			hasIndex,
		});
	}

	// Default sort: most recent activity first, projects with no activity last
	rollups.sort((a, b) => {
		if (a.lastActivity && b.lastActivity) return b.lastActivity - a.lastActivity;
		if (a.lastActivity) return -1;
		if (b.lastActivity) return 1;
		return a.slug.localeCompare(b.slug);
	});

	return json({ projects: rollups, total: rollups.length });
};
