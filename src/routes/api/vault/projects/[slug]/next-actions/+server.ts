/** GET /api/vault/projects/:slug/next-actions
 *
 *  Derived view over the project's phase data — the AI-facing surface for
 *  "what's open" / "what should we do next". Returns:
 *
 *   - open_phases: phases with status in [proposed, accepted], sorted by
 *     falsifier_date ascending (nulls last). Blocked phases (via ADR-level
 *     `blocked_by` deps that aren't yet shipped) are split out.
 *   - blocked_phases: same status filter, but ADR has unmet `blocked_by`.
 *   - recent_shipped: last 5 shipped phases by shipped_at desc.
 *   - next: open_phases[0] — the single "do this next" hint.
 *
 *  Per project-phases ADR-001 P2. Pure read transform over engine.getNotes()
 *  + phase-parser. No explicit cache — engine results refresh on watcher
 *  re-index, and parser is <10ms per ADR. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { parsePhases, type Phase } from '$lib/vault/phase-parser.js';
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

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

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

	// Compute phases per ADR + tag each with the originating ADR path so we
	// can apply the blocked-check later. parsePhases failures are skipped
	// silently (same contract as the projects endpoint — never break).
	const allPhases: Array<{ phase: Phase; adrPath: string }> = [];
	for (const dn of decisionNotes) {
		try {
			const { phases } = parsePhases({
				adrPath: dn.path,
				adrBody: dn.body,
				adrMeta: dn.meta,
				projectIndexBody: projectIndexContent,
			});
			for (const phase of phases) allPhases.push({ phase, adrPath: dn.path });
		} catch {
			// skip
		}
	}

	const isBlocked = (adrPath: string): boolean => {
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
	recentShipped.sort((a, b) => (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''));
	recentShipped.splice(5); // keep last 5

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
