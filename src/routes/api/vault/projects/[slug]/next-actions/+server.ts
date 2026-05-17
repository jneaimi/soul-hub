/** GET /api/vault/projects/:slug/next-actions[?shipped_limit=N]
 *
 *  Derived view over the project's phase data — the AI-facing surface for
 *  "what's open" / "what should we do next". Returns:
 *
 *   - open_phases: phases with status in [proposed, accepted], sorted by
 *     falsifier_date ascending (nulls last). Blocked phases (via ADR-level
 *     `blocked_by` deps that aren't yet shipped) are split out.
 *   - blocked_phases: same status filter, but ADR has unmet `blocked_by`.
 *   - recent_shipped: last N shipped phases by shipped_at desc, then by
 *     phase.id desc as a deterministic tie-break (newer ADRs win when many
 *     slices ship on the same day). N defaults to 10 — covers the operator-
 *     observed case of one project shipping 4+ ADR slices same-day. Override
 *     via `?shipped_limit=N` (1-50). Per project-phases ADR-002 S3.
 *   - next: open_phases[0] — the single "do this next" hint.
 *
 *  Per project-phases ADR-001 P2. Pure read transform over engine.getNotes()
 *  + phase-parser. No explicit cache — engine results refresh on watcher
 *  re-index, and parser is <10ms per ADR. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { parsePhases, parseProjectRoadmap, type Phase } from '$lib/vault/phase-parser.js';
import type { VaultMeta } from '$lib/vault/types.js';

interface NextActionsResponse {
	project: string;
	generated_at: string;
	open_phases: Phase[];
	blocked_phases: Phase[];
	recent_shipped: Phase[];
	next: Phase | null;
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

/** Parse a `blocked_by` value (wikilink or bare slug) down to a comparable
 *  slug. `[[adr-001-foo|alias]]` → `adr-001-foo`. `adr-002` → `adr-002`.
 *  Cross-project refs (`[[../other/adr-X]]`) return the last segment. */
function blockedByToSlug(raw: string): string | null {
	const trimmed = raw.trim();
	const wiki = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
	const target = wiki ? wiki[1].trim() : trimmed;
	const last = target.split('/').pop() ?? target;
	return last.replace(/\.md$/i, '') || null;
}

/** ADR-002 S3 — parse and clamp the optional `?shipped_limit=N` query param.
 *  Bounded [1, 50]; falls back to default (10) on missing / non-numeric /
 *  out-of-range input. */
const DEFAULT_SHIPPED_LIMIT = 10;
const MAX_SHIPPED_LIMIT = 50;

function parseShippedLimit(raw: string | null): number {
	if (!raw) return DEFAULT_SHIPPED_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_SHIPPED_LIMIT;
	return Math.min(n, MAX_SHIPPED_LIMIT);
}

export const GET: RequestHandler = async ({ params, url }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const shippedLimit = parseShippedLimit(url.searchParams.get('shipped_limit'));

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const notes = engine
		.getNotes({ project: slug, limit: 500 })
		.filter((n) => !n.path.startsWith('archive/'));

	// First pass — collect project-index body, list decision notes, and
	// build the set of shipped ADR slugs (used to determine which deps are
	// satisfied for the blocked_phases filter).
	let projectIndexContent: string | undefined;
	const decisionNotes: Array<{ path: string; slug: string; body: string; meta: VaultMeta }> = [];
	const shippedAdrSlugs = new Set<string>();
	const blockedByPerAdr = new Map<string, string[]>();

	for (const note of notes) {
		const full = engine.getNote(note.path);
		if (!full) continue;

		if (note.path === `projects/${slug}/index.md`) {
			projectIndexContent = full.content;
		}

		if (full.meta.type === 'decision') {
			const adrSlug = note.path.split('/').pop()?.replace(/\.md$/i, '') ?? note.path;
			const status = String(full.meta.status ?? '').toLowerCase();
			decisionNotes.push({
				path: note.path,
				slug: adrSlug,
				body: full.content,
				meta: full.meta,
			});
			if (status === 'shipped') shippedAdrSlugs.add(adrSlug);

			const blockedBy = asStringArray(full.meta.blocked_by ?? full.meta.blockedBy);
			if (blockedBy.length > 0) blockedByPerAdr.set(note.path, blockedBy);
		}
	}

	// Two-channel phase collection (mirrors the rollup endpoint's model):
	//   - project-level phases come from the project-index roadmap, parsed
	//     once via parseProjectRoadmap (no per-ADR merging)
	//   - adr-body phases come from each ADR's parsePhases, filtered to
	//     `source: 'adr-body'` (in-body markers + merged-with-roadmap)
	// When an adr-body phase claims an ordinal that a project-level phase
	// also describes, the adr-body version replaces the project-level one —
	// they're the same logical milestone, ADR has richer info (commit,
	// shipped_at, ADR-scoped id for blocked-check). No double-count.
	const projectPhases: Phase[] = projectIndexContent
		? parseProjectRoadmap(slug, projectIndexContent)
		: [];

	const adrBodyPhases: Array<{ phase: Phase; adrPath: string }> = [];
	for (const dn of decisionNotes) {
		try {
			const { phases } = parsePhases({
				adrPath: dn.path,
				adrBody: dn.body,
				adrMeta: dn.meta,
				projectIndexBody: projectIndexContent,
			});
			for (const phase of phases) {
				if (phase.source === 'adr-body') adrBodyPhases.push({ phase, adrPath: dn.path });
			}
		} catch {
			// skip
		}
	}

	const adrBodyOrdinals = new Set(adrBodyPhases.map((x) => x.phase.ordinal));
	const allPhases: Array<{ phase: Phase; adrPath: string | null }> = [];
	for (const p of projectPhases) {
		if (adrBodyOrdinals.has(p.ordinal)) continue; // adr-body claims this milestone
		allPhases.push({ phase: p, adrPath: null });
	}
	for (const x of adrBodyPhases) allPhases.push(x);

	const isBlocked = (adrPath: string | null): boolean => {
		if (!adrPath) return false; // project-level phase, no ADR-level deps
		const deps = blockedByPerAdr.get(adrPath);
		if (!deps || deps.length === 0) return false;
		// Blocked if ANY dep slug is not in the shipped set. Cross-project
		// deps (slugs not in this project) are conservatively treated as
		// unshipped — operator can resolve manually.
		return deps.some((dep) => {
			const depSlug = blockedByToSlug(dep);
			return depSlug ? !shippedAdrSlugs.has(depSlug) : false;
		});
	};

	const isOpen = (status: string) => status === 'proposed' || status === 'accepted';

	// Dedupe by phase.id — project-index phases get the same ID across all
	// ADRs in the project (one logical milestone per project). Per-ADR
	// phases (source: 'adr-body') get distinct IDs naturally.
	//
	// Blocked-check applies ONLY to per-ADR phases. Project-level phases
	// represent shared milestones; their "blocked" status doesn't map to
	// any single ADR's blocked_by frontmatter.
	const openPhases: Phase[] = [];
	const blockedPhases: Phase[] = [];
	const seenIds = new Set<string>();
	for (const { phase, adrPath } of allPhases) {
		if (!isOpen(phase.status)) continue;
		if (seenIds.has(phase.id)) continue;
		seenIds.add(phase.id);
		const blocked = phase.source === 'adr-body' && isBlocked(adrPath);
		if (blocked) blockedPhases.push(phase);
		else openPhases.push(phase);
	}

	// Sort open by falsifier_date asc, nulls last; tie-break by id.
	openPhases.sort((a, b) => {
		const af = a.falsifier_date;
		const bf = b.falsifier_date;
		if (af && bf) return af.localeCompare(bf) || a.id.localeCompare(b.id);
		if (af) return -1;
		if (bf) return 1;
		return a.id.localeCompare(b.id);
	});

	// recent_shipped also dedupes by id (so project-index phases marked shipped
	// don't appear once per ADR).
	const shippedSeenIds = new Set<string>();
	const recentShipped: Phase[] = [];
	for (const { phase } of allPhases) {
		if (phase.status !== 'shipped' || !phase.shipped_at) continue;
		if (shippedSeenIds.has(phase.id)) continue;
		shippedSeenIds.add(phase.id);
		recentShipped.push(phase);
	}
	// ADR-002 S3 — sort by shipped_at desc, then phase.id desc as the tie-break.
	// Without a tie-break, projects shipping multiple slices on the same day
	// (e.g. naseej 2026-05-17: 4 ADR-006 slices + 3 ADR-007 slices + 1 ADR-003)
	// have an arbitrary order, so a small `recent_shipped` cap deterministically
	// hid some ADRs' slices. phase.id desc puts newer ADRs (lexicographically
	// higher slug → higher number) first when shipped_at ties.
	recentShipped.sort((a, b) => {
		const dateCmp = (b.shipped_at ?? '').localeCompare(a.shipped_at ?? '');
		if (dateCmp !== 0) return dateCmp;
		return b.id.localeCompare(a.id);
	});
	recentShipped.splice(shippedLimit);

	const response: NextActionsResponse = {
		project: slug,
		generated_at: new Date().toISOString(),
		open_phases: openPhases,
		blocked_phases: blockedPhases,
		recent_shipped: recentShipped,
		next: openPhases[0] ?? null,
	};

	return json(response);
};
