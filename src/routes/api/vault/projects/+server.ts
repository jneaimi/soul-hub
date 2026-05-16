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
import { parsePhases, type Phase } from '$lib/vault/phase-parser.js';
import type { VaultMeta } from '$lib/vault/types.js';

const PROJECT_ZONE = 'projects';

/** Canonical status set per ~/vault/projects/CLAUDE.md governance.
 *  See ~/vault/knowledge/learnings/2026-05-14-adr-status-canonical-set.md.
 *  `other` should always be 0 — non-zero means a non-canonical status
 *  has crept back in and the migration script needs to be re-run. */
type StatusCounts = {
	proposed: number;
	accepted: number;
	shipped: number;
	rejected: number;
	parked: number;
	superseded: number;
	other: number;
};

interface DecisionRow {
	path: string;
	title: string;
	status: string;
	created: string | null;
	acceptedOn: string | null;
	shippedOn: string | null;
	targetDate: string | null;
	dateInferred: boolean;
	falsifierDate: string | null;
	falsifierDaysAway: number | null;
	tags: string[];
	blockedBy: string[];
	/** Structured phase milestones extracted from the ADR body and the
	 *  project-index roadmap (project-phases ADR-001 Phase 2). Empty on
	 *  parse failure — never breaks the list view. Only attached when
	 *  the caller requested per-decision detail (single-slug query). */
	phases?: Phase[];
}

interface ProjectRollup {
	slug: string;
	adrCount: number;
	noteCount: number;
	statusCounts: StatusCounts;
	openCount: number;
	lastActivity: number | null;
	upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
	hasIndex: boolean;
	indexPath: string | null;
	/** Slug of parent project, or null for root projects. Per ADR-038
	 *  D2/D3: stored on `index.md` as `parent_project: "[[slug|alias]]"`.
	 *  Inverted client-side to build the tree (child_projects is not stored). */
	parentProject: string | null;
	decisions?: DecisionRow[];
}

/** Extract the target slug from a parent_project wikilink value.
 *  Accepts `[[slug]]` or `[[slug|alias]]` or `[[path/to/slug]]`. Returns
 *  null if the value is missing or not a wikilink. */
function parseParentSlug(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(raw.trim());
	if (!m) return null;
	// If target is a path like `projects/soul-hub|index|soul-hub`, take the
	// last segment so we get the project slug, not the directory chain.
	const target = m[1].trim();
	const lastSeg = target.split('/').pop() ?? target;
	return lastSeg || null;
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

function emptyStatusCounts(): StatusCounts {
	return { proposed: 0, accepted: 0, shipped: 0, rejected: 0, parked: 0, superseded: 0, other: 0 };
}

function bucketStatus(raw: unknown): keyof StatusCounts {
	const s = String(raw ?? '').toLowerCase();
	if (s === 'proposed') return 'proposed';
	if (s === 'accepted') return 'accepted';
	if (s === 'shipped') return 'shipped';
	if (s === 'rejected') return 'rejected';
	if (s === 'parked') return 'parked';
	if (s === 'superseded') return 'superseded';
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

	// When a single slug is requested, include per-decision rows on the rollup.
	// Skipped on the list view to keep the payload tight.
	const includeDecisions = filterSet !== null && filterSet.size === 1;

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
		// Archive zone is excluded: per archive/CLAUDE.md, notes there are
		// out of the active lifecycle, so they should not show in project
		// stat counts or the decisions list.
		const notes = engine
			.getNotes({ project: slug, limit: 500 })
			.filter((n) => !n.path.startsWith('archive/'));

		const counts = emptyStatusCounts();
		let adrCount = 0;
		let lastActivity: number | null = null;
		let hasIndex = false;
		let indexPath: string | null = null;
		let parentProject: string | null = null;
		const upcomingFalsifiers: ProjectRollup['upcomingFalsifiers'] = [];
		const decisions: DecisionRow[] = [];

		// project-phases ADR-001 P2: per-ADR phase extraction needs both the
		// ADR body and the parent project-index body (Pattern A roadmap rows).
		// Capture both during the first pass; attach phases in a second pass
		// once the index body is known.
		let projectIndexContent: string | undefined;
		const phaseTargets: Array<{ row: DecisionRow; body: string; meta: VaultMeta }> = [];

		for (const note of notes) {
			const full = engine.getNote(note.path);
			if (!full) continue;

			// Only the project ROOT index.md owns the rollup metadata. Nested
			// `index.md` files (design/, content-bank/, docs/) would otherwise
			// clobber `parentProject` to null, since they don't carry the
			// parent_project frontmatter.
			if (note.path === `projects/${slug}/index.md`) {
				hasIndex = true;
				indexPath = note.path;
				parentProject = parseParentSlug(full.meta.parent_project);
				projectIndexContent = full.content;
			}

			if (full.mtime && (!lastActivity || full.mtime > lastActivity)) {
				lastActivity = full.mtime;
			}

			if (full.meta.type === 'decision') {
				adrCount++;
				const status = String(full.meta.status ?? '').toLowerCase();
				const bucket = bucketStatus(full.meta.status);
				counts[bucket]++;

				const falsifier =
					asIsoDate(full.meta.falsifier_date) ?? asIsoDate(full.meta.falsifierDate);
				if (falsifier) {
					const days = daysBetween(falsifier);
					if (days !== null && days >= -1 && days <= 60) {
						upcomingFalsifiers.push({ path: note.path, date: falsifier, daysAway: days });
					}
				}

				if (includeDecisions) {
					const created = asIsoDate(full.meta.created);
					const row: DecisionRow = {
						path: note.path,
						title:
							typeof full.meta.title === 'string' && full.meta.title
								? full.meta.title
								: note.title || note.path.split('/').pop()?.replace(/\.md$/, '') || note.path,
						status,
						created,
						acceptedOn: asIsoDate(full.meta.accepted_on ?? full.meta.acceptedOn),
						shippedOn: asIsoDate(full.meta.shipped_on ?? full.meta.shippedOn),
						targetDate: asIsoDate(full.meta.target_date ?? full.meta.targetDate),
						dateInferred: full.meta.date_inferred === true || full.meta.dateInferred === true,
						falsifierDate: falsifier,
						falsifierDaysAway: falsifier ? daysBetween(falsifier) : null,
						tags: asStringArray(full.meta.tags),
						blockedBy: asStringArray(full.meta.blocked_by ?? full.meta.blockedBy),
					};
					decisions.push(row);
					phaseTargets.push({ row, body: full.content, meta: full.meta });
				}
			}
		}

		// Second pass — attach phases now that the project-index body is known.
		// Wrap each call in try/catch so a parser failure on one ADR cannot
		// break the list view (per ADR-001 contract: "never break the list").
		if (includeDecisions && phaseTargets.length > 0) {
			for (const target of phaseTargets) {
				try {
					const { phases } = parsePhases({
						adrPath: target.row.path,
						adrBody: target.body,
						adrMeta: target.meta,
						projectIndexBody: projectIndexContent,
					});
					target.row.phases = phases;
				} catch {
					target.row.phases = [];
				}
			}
		}

		upcomingFalsifiers.sort((a, b) => a.daysAway - b.daysAway);

		// Decision sort: proposed first (then by created asc — oldest first), then
		// everything else by created desc (newest first). This is what the detail
		// page wants: open decisions on top, recent shipped/accepted right after.
		if (includeDecisions) {
			const statusRank = (s: string) =>
				s === 'proposed' ? 0
				: s === 'accepted' ? 1
				: s === 'shipped' ? 2
				: s === 'superseded' ? 3
				: s === 'parked' ? 4
				: s === 'rejected' ? 5
				: 6;
			decisions.sort((a, b) => {
				const r = statusRank(a.status) - statusRank(b.status);
				if (r !== 0) return r;
				if (a.status === 'proposed' && b.status === 'proposed') {
					return (a.created ?? '').localeCompare(b.created ?? '');
				}
				return (b.created ?? '').localeCompare(a.created ?? '');
			});
		}

		rollups.push({
			slug,
			adrCount,
			noteCount: notes.length,
			statusCounts: counts,
			openCount: counts.proposed,
			lastActivity,
			upcomingFalsifiers,
			hasIndex,
			indexPath,
			parentProject,
			...(includeDecisions ? { decisions } : {}),
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
