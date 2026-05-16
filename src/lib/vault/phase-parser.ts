/**
 * Phase parser — extracts structured phase milestones from ADR bodies and
 * project-index roadmap tables.
 *
 * Two shapes are handled per the project-phases ADR-001 contract:
 *
 *   Pattern A (project-index roadmap): a `## Roadmap` heading followed by a
 *   markdown table with columns `Phase | Scope | Estimate`. Used by naseej
 *   and similar multi-phase projects.
 *
 *   Pattern B (in-ADR inline markers): stratified bold status lines such as
 *   `**PASS 2 SHIPPED 2026-05-16**` inside an ADR body. Used by
 *   soul-hub-whatsapp ADRs.
 *
 * Resolution: frontmatter dates beat prose dates; roadmap rows supply scope,
 * prose markers supply status; later in-body assertions win for the same
 * ordinal. The parser is a pure function — no I/O, deterministic for the
 * same inputs.
 *
 * Distinct from `playbook-bridge.ts`'s runtime `PhaseResult` (playbook agent
 * assignments) — different domain, same word.
 */

import type { VaultMeta } from './types.js';

export type PhaseStatus =
	| 'proposed'
	| 'accepted'
	| 'shipped'
	| 'parked'
	| 'superseded'
	| 'rejected'
	| 'unknown';

export type PhaseSource = 'adr-body' | 'project-index' | 'frontmatter';

export interface Phase {
	id: string;
	ordinal: number;
	label: string;
	status: PhaseStatus;
	shipped_at?: string;
	target_date?: string;
	falsifier_date?: string;
	commit?: string;
	source: PhaseSource;
	scope?: string;
	raw_marker: string;
	qualifiers: string[];
}

export type ParserWarningKind =
	| 'ambiguous_status'
	| 'duplicate_ordinal'
	| 'unparseable_marker'
	| 'conflict_with_roadmap';

export interface ParserWarning {
	kind: ParserWarningKind;
	detail: string;
	raw?: string;
}

export interface ParserInput {
	adrPath: string;
	adrBody: string;
	adrMeta: VaultMeta;
	projectIndexBody?: string;
}

export interface ParserOutput {
	phases: Phase[];
	warnings: ParserWarning[];
}

/** Inline phase-marker regex. Captures family (`Phase|PASS|Pass|Stage`),
 *  ordinal group (digits + separators + optional `lite` qualifier), and
 *  status verb. Status verbs are uppercase by convention — the stratified
 *  pattern uses `**PASS 2 SHIPPED ...**` not `Pass 2 shipped`. */
const INLINE_MARKER_RE =
	/\b(Phase|PASS|Pass|Stage)\s+([\d+\s/.\-]+?(?:\s+lite)?)\s+(SHIPPED|ACCEPTED|PROPOSED|PARKED|SUPERSEDED|REJECTED|MERGED)\b/g;

/** Status verbs → canonical 6-status vocabulary. `MERGED` collapses to
 *  `shipped`; `DEFERRED` collapses to `parked` (operator convention in
 *  naseej and project-phases roadmap tables — "deferred until a workflow
 *  asks" maps semantically to "actively paused"). */
function normalizeStatus(verb: string): PhaseStatus {
	const v = verb.toUpperCase();
	if (v === 'SHIPPED' || v === 'MERGED') return 'shipped';
	if (v === 'ACCEPTED') return 'accepted';
	if (v === 'PROPOSED') return 'proposed';
	if (v === 'PARKED' || v === 'DEFERRED') return 'parked';
	if (v === 'SUPERSEDED') return 'superseded';
	if (v === 'REJECTED') return 'rejected';
	return 'unknown';
}

/** Regex covering every canonical status verb + the documented synonyms.
 *  Case-insensitive so `Shipped`, `shipped`, `SHIPPED` all match. */
const STATUS_VERB_RE =
	/\b(SHIPPED|ACCEPTED|PROPOSED|PARKED|SUPERSEDED|REJECTED|MERGED|DEFERRED)\b/i;

/** Expand an ordinal group string into individual numeric ordinals.
 *  Handles `1`, `1+2`, `0 + 1 + 4`, `2/3`, `1.5`. Returns `[]` on
 *  unparseable input — the caller should warn. */
function expandOrdinals(group: string): number[] {
	const cleaned = group.replace(/\blite\b/gi, '').trim();
	if (!cleaned) return [];
	const parts = cleaned.split(/[+\s/]+/).filter(Boolean);
	const ordinals: number[] = [];
	for (const p of parts) {
		const n = Number.parseFloat(p);
		if (!Number.isFinite(n)) return [];
		ordinals.push(n);
	}
	return ordinals;
}

/** Pull a YYYY-MM-DD date that appears within `radius` characters of the
 *  marker. Returns null if none found. Used for shipped_at extraction from
 *  prose like `**PASS 2 SHIPPED 2026-05-16**`. */
function extractNearbyDate(body: string, markerEnd: number, radius = 80): string | null {
	const slice = body.slice(markerEnd, markerEnd + radius);
	const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(slice);
	return m ? m[1] : null;
}

/** Pull a git short-SHA that appears within `radius` characters of the
 *  marker. Matches `commit <sha>` or `commit \`<sha>\``. */
function extractNearbyCommit(body: string, markerEnd: number, radius = 120): string | null {
	const slice = body.slice(markerEnd, markerEnd + radius);
	const m = /commit\s+`?([a-f0-9]{7,40})`?/i.exec(slice);
	return m ? m[1] : null;
}

/** ADR slug for use in phase IDs. Strips zone prefix + `.md` extension.
 *  Example: `projects/naseej/adr-001-foo.md` → `adr-001-foo`. */
function adrSlugFromPath(adrPath: string): string {
	const basename = adrPath.split('/').pop() ?? adrPath;
	return basename.replace(/\.md$/i, '');
}

/** Project slug from an ADR path. Used for project-index phase IDs so that
 *  multiple ADRs sharing the same roadmap produce phases with IDENTICAL IDs
 *  (one logical milestone per project, not per-ADR). Example:
 *  `projects/naseej/adr-001-foo.md` → `naseej`. Returns null if the path
 *  doesn't have the expected `projects/<slug>/...` shape. */
function projectSlugFromAdrPath(adrPath: string): string | null {
	const parts = adrPath.split('/');
	if (parts.length < 3 || parts[0] !== 'projects') return null;
	return parts[1] || null;
}

/** Strip fenced code blocks and inline code spans before pattern matching,
 *  same approach as `src/lib/vault/parser.ts:extractLinks`. ADRs frequently
 *  document the marker syntax pedagogically (`` `Phase 1 SHIPPED` `` inside
 *  a table cell or fenced example); without this stripping the parser would
 *  treat those examples as real phase markers. */
function stripCodeForMarkerScan(content: string): string {
	let stripped = content
		// Fenced blocks: opener + closer must be at start-of-line (per CommonMark)
		.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '')
		// Inline code spans, constrained to a single line
		.replace(/(`+)[^\n]+?\1/g, '');
	return stripped;
}

/** Pattern B — walk the ADR body for inline phase markers.
 *
 *  Scans the code-stripped body for matches (so pedagogical examples in
 *  backticks/fences don't leak), then locates each match in the ORIGINAL
 *  body to extract surrounding dates/commits — commits are by convention
 *  written as `commit \`<sha>\`` so the SHA itself lives inside inline
 *  code and would be lost if we extracted from the stripped body. */
function extractInAdrMarkers(adrPath: string, body: string, warnings: ParserWarning[]): Phase[] {
	const slug = adrSlugFromPath(adrPath);
	const phases: Phase[] = [];
	const scanBody = stripCodeForMarkerScan(body);
	const re = new RegExp(INLINE_MARKER_RE.source, INLINE_MARKER_RE.flags);
	let match: RegExpExecArray | null;
	let bodyCursor = 0;

	while ((match = re.exec(scanBody)) !== null) {
		const family = match[1];
		const ordinalGroup = match[2].trim();
		const verb = match[3];
		const ordinals = expandOrdinals(ordinalGroup);

		if (ordinals.length === 0) {
			warnings.push({
				kind: 'unparseable_marker',
				detail: `Cannot expand ordinal group "${ordinalGroup}"`,
				raw: match[0]
			});
			continue;
		}

		const qualifiers: string[] = [];
		if (/\blite\b/i.test(ordinalGroup)) qualifiers.push('lite');

		const status = normalizeStatus(verb);

		// Locate this marker's position in the ORIGINAL body (not the
		// code-stripped scan body) so commit-SHA extraction sees backticked
		// short-SHAs. Each scan match has at least one corresponding
		// occurrence in the original (since stripping only removed text,
		// not the markers themselves).
		const bodyIdx = body.indexOf(match[0], bodyCursor);
		const markerEnd = bodyIdx >= 0 ? bodyIdx + match[0].length : match.index + match[0].length;
		const dateCommitSource = bodyIdx >= 0 ? body : scanBody;
		if (bodyIdx >= 0) bodyCursor = markerEnd;

		const shipped_at =
			status === 'shipped' ? (extractNearbyDate(dateCommitSource, markerEnd) ?? undefined) : undefined;
		const commit =
			status === 'shipped' ? (extractNearbyCommit(dateCommitSource, markerEnd) ?? undefined) : undefined;

		for (const ord of ordinals) {
			const label = `${family} ${ord}`;
			phases.push({
				id: `${slug}#phase-${ord}`,
				ordinal: ord,
				label,
				status,
				shipped_at,
				commit,
				source: 'adr-body',
				raw_marker: match[0],
				qualifiers
			});
		}
	}

	return phases;
}

/** Pattern A — extract phases from a project-index `## Roadmap` heading
 *  followed by a 3-column markdown table. Phase IDs use the project slug
 *  (not the ADR slug) so that multiple ADRs sharing the same roadmap
 *  produce identical IDs — one logical milestone per project. */
function extractRoadmapPhases(
	adrPath: string,
	indexBody: string,
	warnings: ParserWarning[]
): Phase[] {
	const slug = projectSlugFromAdrPath(adrPath) ?? adrSlugFromPath(adrPath);
	const phases: Phase[] = [];

	const headingMatch = /^##\s+Roadmap\b/im.exec(indexBody);
	if (!headingMatch) return phases;

	const tableStart = indexBody.indexOf('|', headingMatch.index + headingMatch[0].length);
	if (tableStart < 0) return phases;

	// Walk forward until we leave the table (blank line or non-pipe line).
	const lines = indexBody.slice(tableStart).split('\n');
	const rows: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) break;
		if (!trimmed.startsWith('|')) break;
		rows.push(trimmed);
	}
	if (rows.length < 3) return phases; // need header + separator + ≥1 data row

	// Skip header row + separator row. Data rows start at index 2.
	for (let i = 2; i < rows.length; i++) {
		const cells = rows[i]
			.split('|')
			.map((c) => c.trim())
			.filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // trim outer empties

		if (cells.length < 1) continue;

		const labelCell = cells[0].replace(/\*\*/g, '').trim();
		const scopeCell = cells[1] ?? '';
		const estimateCell = cells[2] ?? '';
		const extraCells = cells.slice(3); // status / notes / whatever columns

		// Ordinal extraction: `P0`, `P1`, `P1.5`, `Phase 2`, etc.
		const ordMatch = /\b[A-Z]?(\d+(?:\.\d+)?)\b/.exec(labelCell);
		if (!ordMatch) continue;
		const ordinal = Number.parseFloat(ordMatch[1]);
		if (!Number.isFinite(ordinal)) continue;

		// Status: default proposed; upgrade by scanning every cell beyond
		// the label for an explicit status verb. Some tables put status
		// inline in the scope cell (project-phases convention); others use
		// a dedicated 4th column (naseej convention with `✅ shipped
		// YYYY-MM-DD`). Both work. Strip code first so backticked phrases
		// like `PHASES N shipped / M open / K blocked` don't match falsely.
		let status: PhaseStatus = 'proposed';
		let shipped_at: string | undefined;
		const statusCandidates = [scopeCell, estimateCell, ...extraCells];
		for (const cell of statusCandidates) {
			const cleaned = stripCodeForMarkerScan(cell);
			const verbMatch = STATUS_VERB_RE.exec(cleaned);
			if (!verbMatch) continue;
			status = normalizeStatus(verbMatch[1]);
			// Extract a YYYY-MM-DD adjacent to the verb (same cell).
			const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(cleaned);
			if (status === 'shipped' && dateMatch) shipped_at = dateMatch[1];
			break;
		}

		const qualifiers: string[] = [];
		if (/\blite\b/i.test(stripCodeForMarkerScan(scopeCell))) qualifiers.push('lite');

		phases.push({
			id: `${slug}#phase-${ordinal}`,
			ordinal,
			label: labelCell,
			status,
			shipped_at,
			source: 'project-index',
			scope: `${scopeCell}${estimateCell ? ` (${estimateCell})` : ''}`.trim() || undefined,
			raw_marker: rows[i],
			qualifiers
		});
	}

	return phases;
}

/** Merge ADR-body markers (Pattern B) with project-index roadmap rows
 *  (Pattern A). Resolution per ADR-001:
 *
 *  - For the same ordinal, ADR-body status wins (later operator assertion).
 *  - Project-index supplies `scope` if ADR-body has none.
 *  - Within ADR-body, later occurrences beat earlier (regex walks top-down,
 *    so the LAST occurrence per ordinal is the kept one).
 *  - Conflicting ordinals emit `duplicate_ordinal` warning. */
function mergePhases(
	adrBody: Phase[],
	projectIndex: Phase[],
	warnings: ParserWarning[]
): Phase[] {
	const byKey = new Map<string, Phase>();

	// Project-index first (lower priority).
	for (const p of projectIndex) {
		const key = `${p.ordinal}|${p.label}`;
		byKey.set(key, p);
	}

	// ADR-body second; later occurrences overwrite earlier for the same ordinal.
	// A project-index row for the SAME ordinal is treated as the same logical
	// phase and gets folded into the ADR-body entry (its label/scope preserved,
	// status overridden by the more recent ADR-body assertion).
	for (const p of adrBody) {
		const exactKey = `${p.ordinal}|${p.label}`;
		const existingExact = byKey.get(exactKey);

		// Find a project-index row with the same ordinal (and remove it from
		// the map — same logical phase, don't double-report).
		let roadmapEntry: Phase | undefined;
		for (const [k, v] of byKey) {
			if (v.ordinal === p.ordinal && v.source === 'project-index' && k !== exactKey) {
				roadmapEntry = v;
				byKey.delete(k);
				break;
			}
		}

		if (existingExact) {
			if (existingExact.status !== p.status) {
				warnings.push({
					kind: 'duplicate_ordinal',
					detail: `Ordinal ${p.ordinal} (${p.label}) seen twice with different statuses: ${existingExact.status} → ${p.status}`,
					raw: p.raw_marker
				});
			}
			byKey.set(exactKey, {
				...existingExact,
				...p,
				scope: p.scope ?? existingExact.scope ?? roadmapEntry?.scope
			});
		} else if (roadmapEntry) {
			// Fold the roadmap row's scope into the ADR-body phase.
			byKey.set(exactKey, { ...p, scope: p.scope ?? roadmapEntry.scope });
		} else {
			byKey.set(exactKey, p);
		}
	}

	return [...byKey.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/** Layer frontmatter dates over the phase list. Per the contract:
 *
 *  - `meta.shipped_on` becomes `shipped_at` for the LATEST shipped phase that
 *    doesn't already have one from prose.
 *  - `meta.target_date` becomes `target_date` for the FIRST non-shipped phase
 *    that doesn't already have one.
 *  - `meta.falsifier_date` is applied to ALL phases as ADR-level signal
 *    (the contract documents falsifier as ADR-level, not per-phase, for v1). */
function layerFrontmatterDates(phases: Phase[], meta: VaultMeta): Phase[] {
	if (phases.length === 0) return phases;

	const out = phases.map((p) => ({ ...p }));

	const fmShipped = asIsoDate(meta.shipped_on);
	if (fmShipped) {
		const shippedPhases = out.filter((p) => p.status === 'shipped');
		const latest = shippedPhases[shippedPhases.length - 1];
		if (latest && !latest.shipped_at) latest.shipped_at = fmShipped;
	}

	const fmTarget = asIsoDate(meta.target_date);
	if (fmTarget) {
		const firstOpen = out.find((p) => p.status === 'proposed' || p.status === 'accepted');
		if (firstOpen && !firstOpen.target_date) firstOpen.target_date = fmTarget;
	}

	const fmFalsifier = asIsoDate(meta.falsifier_date);
	if (fmFalsifier) {
		for (const p of out) if (!p.falsifier_date) p.falsifier_date = fmFalsifier;
	}

	return out;
}

/** Coerce a YAML date|string|Date value to ISO YYYY-MM-DD. */
function asIsoDate(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const t = raw.trim();
		return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
	}
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
		return raw.toISOString().slice(0, 10);
	}
	return null;
}

/** If no in-body markers and no roadmap rows produced any phases, but the
 *  ADR has a status in its frontmatter, synthesize a single Phase 1 from
 *  the frontmatter so the consumer always has at least one entry per ADR. */
function fallbackFromFrontmatter(adrPath: string, meta: VaultMeta): Phase {
	const slug = adrSlugFromPath(adrPath);
	const status = normalizeStatus(String(meta.status ?? 'proposed').toUpperCase());
	return {
		id: `${slug}#phase-1`,
		ordinal: 1,
		label: 'Phase 1',
		status,
		shipped_at: asIsoDate(meta.shipped_on) ?? undefined,
		target_date: asIsoDate(meta.target_date) ?? undefined,
		falsifier_date: asIsoDate(meta.falsifier_date) ?? undefined,
		source: 'frontmatter',
		raw_marker: '',
		qualifiers: []
	};
}

export function parsePhases(input: ParserInput): ParserOutput {
	const warnings: ParserWarning[] = [];

	const fromAdr = extractInAdrMarkers(input.adrPath, input.adrBody, warnings);
	const fromIndex = input.projectIndexBody
		? extractRoadmapPhases(input.adrPath, input.projectIndexBody, warnings)
		: [];

	let phases = mergePhases(fromAdr, fromIndex, warnings);

	if (phases.length === 0) {
		phases = [fallbackFromFrontmatter(input.adrPath, input.adrMeta)];
	} else {
		phases = layerFrontmatterDates(phases, input.adrMeta);
	}

	return { phases, warnings };
}
