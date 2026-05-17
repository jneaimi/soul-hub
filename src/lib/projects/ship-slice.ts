/**
 * Atomic ship-slice mutation primitives. Per project-phases ADR-003.
 *
 * Pure functions over markdown text — no I/O. The endpoint composes these
 * + reads/writes via the vault engine (which itself routes through the
 * ADR-046 chokepoint).
 *
 * Three mutation surfaces are wired in v1:
 *
 *   1. Status header running tally  — `**S1+S2 SHIPPED YYYY-MM-DD**` line
 *   2. Project index ship log prepend — first entry under `## Ship log`
 *
 * Deferred to a future ADR-003 polish slice:
 *
 *   - Checkpoints table row mutation (regex-anchored on label cell)
 *   - Falsifier scorecard flip (handled cleanly by ADR-004)
 */

import { z } from 'zod';

// ─── Zod schema for the request body ─────────────────────────────────────────

const STATUS_VALUES = ['shipped', 'accepted', 'parked', 'superseded', 'rejected'] as const;
const STATUS_VERB: Record<typeof STATUS_VALUES[number], string> = {
	shipped: 'SHIPPED',
	accepted: 'ACCEPTED',
	parked: 'PARKED',
	superseded: 'SUPERSEDED',
	rejected: 'REJECTED',
};

export const ShipSliceRequestSchema = z
	.object({
		/** ADR identifier — either the bare ordinal ("007"), the bare slug
		 *  ("adr-007-peer-brief-naseej-port"), or the full vault path
		 *  ("projects/naseej/adr-007-peer-brief-naseej-port.md"). The endpoint
		 *  resolves all three forms against `projects/<slug>/`. */
		adr: z.string().trim().min(1),
		/** Slice label as it appears in the ADR — `S3`, `CP4.2`, `Phase 1`,
		 *  `Stage 1`. Case-sensitive. Must match exactly how the operator
		 *  writes it in the Status section running tally. */
		slice_id: z
			.string()
			.trim()
			.regex(/^(S|CP|Phase|PASS|Pass|Stage)\s*\d+(?:\.\d+)?$/, {
				message: 'slice_id must match `S<N>` / `CP<N>` / `Phase <N>` / `PASS <N>` / `Stage <N>`',
			}),
		status: z.enum(STATUS_VALUES),
		commit: z
			.string()
			.trim()
			.regex(/^[a-f0-9]{7,40}$/, { message: 'commit must be a git short-SHA (7-40 hex chars)' })
			.optional(),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
			.optional(),
		bundle: z.string().trim().min(1).optional(),
		notes: z.string().trim().min(1).optional(),
		closes_falsifier: z
			.string()
			.trim()
			.regex(/^F\d+$/, { message: 'closes_falsifier must match `F<N>`' })
			.optional(),
	})
	.strict();

export type ShipSliceRequest = z.infer<typeof ShipSliceRequestSchema>;

// ─── ADR path resolution ─────────────────────────────────────────────────────

/** Resolve any of the accepted `adr` shorthand forms to a full vault path.
 *  Returns null when the shorthand can't be normalized. Caller verifies the
 *  file actually exists. */
export function resolveAdrPath(slug: string, adr: string): string | null {
	const trimmed = adr.trim();
	if (!trimmed) return null;
	// Full path passes through unchanged.
	if (trimmed.startsWith('projects/') && trimmed.endsWith('.md')) return trimmed;
	// Bare slug `adr-007-peer-brief-naseej-port`.
	if (trimmed.startsWith('adr-')) return `projects/${slug}/${trimmed}.md`;
	// Bare ordinal `007` or `7` — caller must already know the rest.
	// The endpoint resolves this against the project index's ADRs list,
	// not in this pure helper.
	return null;
}

/** Given the project index body, find the full vault path for an ADR
 *  identified by a bare ordinal like `7` or `007`. Looks for the wikilink
 *  pattern `[[adr-007-...|...]]` in the ADRs section. */
export function findAdrPathByOrdinal(indexBody: string, slug: string, ordinal: string): string | null {
	const padded = ordinal.padStart(3, '0');
	const wikiRe = new RegExp(`\\[\\[(adr-${padded}-[a-z0-9-]+)(?:\\|[^\\]]*)?\\]\\]`);
	const m = wikiRe.exec(indexBody);
	if (!m) return null;
	return `projects/${slug}/${m[1]}.md`;
}

// ─── Mutation 1: ADR Status section running tally ─────────────────────────────

const SLICE_LABEL_RE = /^(S|CP|Phase|PASS|Pass|Stage)\s*(\d+(?:\.\d+)?)$/;

interface ParsedSliceLabel {
	family: string;
	ordinal: number;
	canonical: string; // exact form as it appears
}

function parseSliceLabel(label: string): ParsedSliceLabel | null {
	const m = SLICE_LABEL_RE.exec(label.trim());
	if (!m) return null;
	return {
		family: m[1],
		ordinal: Number.parseFloat(m[2]),
		canonical: label.trim(),
	};
}

/** Find the existing running-tally line in the ADR Status section and either
 *  add the new slice to its ordinal list (if status matches), or append a NEW
 *  per-slice marker line below it. v1 always appends a new marker line — this
 *  keeps the audit trail visible. The aggregated tally lines like
 *  `**S1+S2+S3 SHIPPED YYYY-MM-DD**` are author-curated.
 *
 *  The new marker line is inserted right after the existing top-of-Status
 *  paragraph. Format:
 *
 *      **<LABEL> <STATUS_VERB> YYYY-MM-DD** commit `<sha>` — <notes if any>
 *
 *  Idempotent: if the exact line is already present, no change. */
export function appendSliceMarkerToStatus(
	body: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): { body: string; changed: boolean } {
	const verb = STATUS_VERB[req.status];
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';
	const newLine = `**${req.slice_id} ${verb} ${resolvedDate}**${commitFragment}${notesFragment}`;

	// Idempotency: bail if the exact line is already in the Status section.
	const statusBlock = extractSection(body, '## Status');
	if (statusBlock && statusBlock.includes(newLine)) {
		return { body, changed: false };
	}

	// Insert right after the first paragraph in `## Status`.
	const statusHeaderRe = /^## Status\s*\n+/m;
	const m = statusHeaderRe.exec(body);
	if (!m) {
		// No `## Status` header — append one at the top.
		return {
			body: `## Status\n\n${newLine}\n\n${body}`,
			changed: true,
		};
	}
	const insertAt = m.index + m[0].length;
	// Skip to end of the next paragraph (first blank line after insertAt).
	const rest = body.slice(insertAt);
	const blankLineIdx = rest.search(/\n\s*\n/);
	const inserted = blankLineIdx >= 0 ? blankLineIdx + 1 : 0;
	const splitAt = insertAt + inserted;
	return {
		body: body.slice(0, splitAt) + `\n${newLine}\n` + body.slice(splitAt),
		changed: true,
	};
}

/** Extract the body of a markdown section between the given heading and the
 *  next heading of the same or higher level. Returns null if not found. */
function extractSection(body: string, heading: string): string | null {
	const level = heading.match(/^#+/)?.[0].length ?? 2;
	const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm');
	const m = re.exec(body);
	if (!m) return null;
	const start = m.index + m[0].length;
	const nextHeadingRe = new RegExp(`^#{1,${level}}\\s`, 'm');
	const after = body.slice(start);
	const next = nextHeadingRe.exec(after);
	return next ? after.slice(0, next.index) : after;
}

// ─── Mutation 2: project index ship log prepend ──────────────────────────────

/** Pure formatter for a ship-log entry line. Shared by `prependShipLogEntry`
 *  (the mutation) and `buildPreview` (the dry-run shape) so both surfaces
 *  show the same string. */
export function formatShipLogEntry(
	adrPath: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): string {
	const verb = STATUS_VERB[req.status];
	const ordinal = adrPath.match(/adr-(\d+)/)?.[1] ?? '???';
	const headline = `ADR-${ordinal} ${req.slice_id} ${verb.toLowerCase()}`;
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';
	return `- **${resolvedDate}** — **${headline}**${commitFragment}${notesFragment}`;
}

/** Prepend a new entry to the project index's `## Ship log` section.
 *  Format (matches existing operator convention across the cluster):
 *
 *      - **YYYY-MM-DD** — **<short summary>** commit `<sha>` — <notes prose>
 *
 *  Idempotent: if the same commit + slice already has an entry, no change.
 *  Returns the unchanged body when the section is missing — the caller logs
 *  a warning but the ship operation continues (author can add Ship log
 *  later). */
export function prependShipLogEntry(
	indexBody: string,
	adrSlug: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): { body: string; changed: boolean } {
	const newEntry = formatShipLogEntry(adrSlug, req, resolvedDate);

	// Idempotency: skip if an identical entry already exists.
	if (indexBody.includes(newEntry)) {
		return { body: indexBody, changed: false };
	}

	const shipLogRe = /^## Ship log\s*\n+/m;
	const m = shipLogRe.exec(indexBody);
	if (!m) {
		return { body: indexBody, changed: false };
	}
	const insertAt = m.index + m[0].length;
	return {
		body: indexBody.slice(0, insertAt) + newEntry + '\n\n' + indexBody.slice(insertAt),
		changed: true,
	};
}

// ─── Compose: dry-run preview shape ──────────────────────────────────────────

export interface ShipSlicePreview {
	adr_path: string;
	index_path: string;
	new_status_line: string;
	new_ship_log_entry: string;
	resolved_date: string;
	status_changed: boolean;
	ship_log_changed: boolean;
	warnings: string[];
}

/** Outcome shape from `applyShipSlice` — shared between the HTTP endpoint
 *  and the orchestrator-v2 tool. */
export interface ApplyShipSliceResult {
	success: boolean;
	applied: boolean;
	preview: ShipSlicePreview;
	error?: string;
	field?: string;
	status_hint?: number; // HTTP status the endpoint would return
	rollback_attempted?: boolean;
	rollback_ok?: boolean;
}

/** Minimal vault engine surface needed for ship-slice. Decouples this module
 *  from `getVaultEngine` so the orchestrator tool can pass any object that
 *  satisfies it (currently the real engine; future tests can pass a mock). */
export interface ShipSliceVaultEngine {
	getNote(path: string): Promise<{ content: string } | null> | { content: string } | null;
	/** ADR-003 S4 — `opts.actor` lets ship-slice stamp the audit log + commit
	 *  with `projectShipSlice` instead of the note's original `source_agent`. */
	updateNote(
		path: string,
		patch: { content?: string },
		opts?: { actor?: string; actorContext?: string },
	): Promise<{ success?: boolean; error?: string }>;
}

/** Shared core for both the HTTP endpoint and the orchestrator-v2 tool.
 *  Validates the request, resolves the ADR path, computes the preview, and
 *  (unless dryRun) writes both notes atomically with rollback. */
export async function applyShipSlice(
	engine: ShipSliceVaultEngine,
	slug: string,
	req: ShipSliceRequest,
	opts: { dryRun?: boolean } = {},
): Promise<ApplyShipSliceResult> {
	const indexPath = `projects/${slug}/index.md`;
	const indexNote = await engine.getNote(indexPath);
	if (!indexNote) {
		return {
			success: false,
			applied: false,
			preview: emptyPreviewShape(),
			error: `project index not found at ${indexPath}`,
			status_hint: 404,
		};
	}
	const indexBody = indexNote.content;

	// Resolve in two passes: literal shorthand first; if the file doesn't
	// exist, fall back to a project-index wikilink lookup (handles partial
	// slugs like `adr-003` that need the descriptive suffix appended).
	let adrPath = resolveAdrPath(slug, req.adr);
	let adrNote = adrPath ? await engine.getNote(adrPath) : null;
	if (!adrNote) {
		// Strip `adr-` prefix if present, then look up by ordinal.
		const ordinalHint = req.adr.replace(/^adr-/, '').split('-')[0];
		const fallbackPath = findAdrPathByOrdinal(indexBody, slug, ordinalHint);
		if (fallbackPath) {
			adrPath = fallbackPath;
			adrNote = await engine.getNote(adrPath);
		}
	}
	if (!adrPath || !adrNote) {
		return {
			success: false,
			applied: false,
			preview: emptyPreviewShape(),
			error: `could not resolve adr "${req.adr}" in project "${slug}" — try a full slug like "adr-007-peer-brief-naseej-port"`,
			field: 'adr',
			status_hint: 400,
		};
	}
	const adrBody = adrNote.content;

	const preview = buildPreview(adrPath, adrBody, indexPath, indexBody, req);

	if (opts.dryRun) {
		return { success: true, applied: false, preview };
	}

	if (!preview.status_changed && !preview.ship_log_changed && preview.warnings.length === 0) {
		return {
			success: false,
			applied: false,
			preview,
			error: 'no-op — slice marker already present and ship-log entry already exists',
			status_hint: 422,
		};
	}

	const resolvedDate = preview.resolved_date;
	const adrUpdate = appendSliceMarkerToStatus(adrBody, req, resolvedDate);
	const indexUpdate = prependShipLogEntry(indexBody, adrPath, req, resolvedDate);

	// ADR-003 S4 — stamp every audit-log + commit entry from this transaction
	// with `projectShipSlice` so the orchestrator's footprint is distinct from
	// the note's original `source_agent` (the human/agent who authored it).
	const SHIP_ACTOR = 'projectShipSlice';
	const shipContext = `slug=${slug} adr=${req.adr} slice=${req.slice_id} status=${req.status}${
		req.commit ? ` commit=${req.commit}` : ''
	}`;
	const writeOpts = { actor: SHIP_ACTOR, actorContext: shipContext };
	const rollbackOpts = {
		actor: SHIP_ACTOR,
		actorContext: `${shipContext} rollback=adr-write`,
	};

	let adrWriteOk = false;
	let indexWriteOk = false;
	let rollbackAttempted = false;
	let rollbackOk = false;
	let failureDetail: string | undefined;

	try {
		if (adrUpdate.changed) {
			const res = await engine.updateNote(adrPath, { content: adrUpdate.body }, writeOpts);
			adrWriteOk = res.success ?? true;
			if (!adrWriteOk) failureDetail = `ADR write refused: ${res.error ?? 'unknown'}`;
		} else {
			adrWriteOk = true;
		}
	} catch (err) {
		failureDetail = `ADR write threw: ${(err as Error).message}`;
	}

	if (adrWriteOk) {
		try {
			if (indexUpdate.changed) {
				const res = await engine.updateNote(indexPath, { content: indexUpdate.body }, writeOpts);
				indexWriteOk = res.success ?? true;
				if (!indexWriteOk) failureDetail = `index write refused: ${res.error ?? 'unknown'}`;
			} else {
				indexWriteOk = true;
			}
		} catch (err) {
			failureDetail = `index write threw: ${(err as Error).message}`;
		}
	}

	if (adrWriteOk && !indexWriteOk && adrUpdate.changed) {
		rollbackAttempted = true;
		try {
			const res = await engine.updateNote(adrPath, { content: adrBody }, rollbackOpts);
			rollbackOk = res.success ?? true;
		} catch {
			rollbackOk = false;
		}
	}

	const allOk = adrWriteOk && indexWriteOk;
	return {
		success: allOk,
		applied: adrWriteOk || indexWriteOk,
		preview,
		error: allOk ? undefined : (failureDetail ?? 'unknown write failure'),
		status_hint: allOk ? 200 : 500,
		rollback_attempted: rollbackAttempted,
		rollback_ok: rollbackOk,
	};
}

function emptyPreviewShape(): ShipSlicePreview {
	return {
		adr_path: '',
		index_path: '',
		new_status_line: '',
		new_ship_log_entry: '',
		resolved_date: new Date().toISOString().slice(0, 10),
		status_changed: false,
		ship_log_changed: false,
		warnings: [],
	};
}

export function buildPreview(
	adrPath: string,
	adrBody: string,
	indexPath: string,
	indexBody: string,
	req: ShipSliceRequest,
): ShipSlicePreview {
	const resolvedDate = req.date ?? new Date().toISOString().slice(0, 10);

	const parsed = parseSliceLabel(req.slice_id);
	const warnings: string[] = [];
	if (!parsed) {
		warnings.push(`slice_id "${req.slice_id}" doesn't match canonical shape — accepted anyway`);
	}

	const statusUpdate = appendSliceMarkerToStatus(adrBody, req, resolvedDate);
	const shipLogUpdate = prependShipLogEntry(indexBody, adrPath, req, resolvedDate);
	if (!shipLogUpdate.changed && !indexBody.includes('## Ship log')) {
		warnings.push('project index has no `## Ship log` section — entry not prepended');
	}

	const verb = STATUS_VERB[req.status];
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';

	return {
		adr_path: adrPath,
		index_path: indexPath,
		new_status_line: `**${req.slice_id} ${verb} ${resolvedDate}**${commitFragment}${notesFragment}`,
		new_ship_log_entry: formatShipLogEntry(adrPath, req, resolvedDate),
		resolved_date: resolvedDate,
		status_changed: statusUpdate.changed,
		ship_log_changed: shipLogUpdate.changed,
		warnings,
	};
}
