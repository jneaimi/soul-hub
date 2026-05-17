/** POST /api/projects/:slug/ship-slice
 *
 *  Atomic ship-slice mutation per project-phases ADR-003. Updates two vault
 *  notes in one logical operation:
 *
 *    1. ADR Status section running tally — appends a per-slice marker line
 *    2. Project index `## Ship log` — prepends a new entry
 *
 *  Both writes route through `engine.updateNote` (chokepoint per ADR-046).
 *
 *  Query params:
 *    ?dry-run=true  Return the computed preview without writing. Use this
 *                   from CI / orchestrator agents to verify the mutation
 *                   before applying.
 *
 *  Request body (Zod-validated):
 *    { adr, slice_id, status, commit?, date?, bundle?, notes?, closes_falsifier? }
 *
 *  Response (success):
 *    { success: true, preview: ShipSlicePreview, applied: true|false }
 *
 *  Response (failure):
 *    { success: false, error: "<reason>", field?: "<field>", details?: {...} }
 *
 *  Failure modes:
 *    400  Invalid body / Zod refusal / unresolvable adr shorthand
 *    404  ADR or project index not found on disk
 *    422  Mutation produced no change AND no warnings (operator should
 *         double-check slice_id and status)
 *    500  Vault engine unavailable, or write failed after preview succeeded
 *
 *  Atomicity contract: if writing the index ship log fails after the ADR
 *  write succeeded, the endpoint restores the original ADR body via a second
 *  `updateNote` call. Reported as partial-rollback in the response. v1 is
 *  best-effort — a failure in BOTH the index write AND the rollback returns
 *  500 with the original states echoed so the operator can fix manually. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import {
	ShipSliceRequestSchema,
	resolveAdrPath,
	findAdrPathByOrdinal,
	buildPreview,
	appendSliceMarkerToStatus,
	prependShipLogEntry,
	type ShipSliceRequest,
} from '$lib/projects/ship-slice.js';

export const POST: RequestHandler = async ({ params, request, url }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = ShipSliceRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return json(
			{
				success: false,
				error: 'invalid request body',
				issues: parsed.error.issues.map((i) => ({
					path: i.path.join('.'),
					message: i.message,
				})),
			},
			{ status: 400 },
		);
	}

	const req: ShipSliceRequest = parsed.data;
	const dryRun = url.searchParams.get('dry-run') === 'true';

	// ── Resolve ADR path ───────────────────────────────────────────────────
	const indexPath = `projects/${slug}/index.md`;
	const indexNote = await engine.getNote(indexPath);
	if (!indexNote) {
		return json(
			{ success: false, error: `project index not found at ${indexPath}` },
			{ status: 404 },
		);
	}
	const indexBody = indexNote.content;

	let adrPath = resolveAdrPath(slug, req.adr);
	if (!adrPath) {
		// Try bare-ordinal resolution against the index.
		adrPath = findAdrPathByOrdinal(indexBody, slug, req.adr);
	}
	if (!adrPath) {
		return json(
			{
				success: false,
				error: `could not resolve adr "${req.adr}" — try a full slug like "adr-007-peer-brief-naseej-port" or a full path`,
				field: 'adr',
			},
			{ status: 400 },
		);
	}

	const adrNote = await engine.getNote(adrPath);
	if (!adrNote) {
		return json(
			{ success: false, error: `ADR not found at ${adrPath}`, field: 'adr' },
			{ status: 404 },
		);
	}
	const adrBody = adrNote.content;

	// ── Compute preview ────────────────────────────────────────────────────
	const preview = buildPreview(adrPath, adrBody, indexPath, indexBody, req);

	if (dryRun) {
		return json({ success: true, applied: false, preview, dry_run: true });
	}

	// 422 when there's literally nothing to do — caller probably has the
	// wrong slice_id or already-current status.
	if (!preview.status_changed && !preview.ship_log_changed && preview.warnings.length === 0) {
		return json(
			{
				success: false,
				applied: false,
				preview,
				error: 'no-op — slice marker already present and ship-log entry already exists',
			},
			{ status: 422 },
		);
	}

	// ── Apply mutations ────────────────────────────────────────────────────
	const resolvedDate = preview.resolved_date;
	const adrUpdate = appendSliceMarkerToStatus(adrBody, req, resolvedDate);
	const indexUpdate = prependShipLogEntry(indexBody, adrPath, req, resolvedDate);

	let adrWriteOk = false;
	let indexWriteOk = false;
	let rollbackAttempted = false;
	let rollbackOk = false;
	let failureDetail: string | undefined;

	try {
		if (adrUpdate.changed) {
			const res = await engine.updateNote(adrPath, { content: adrUpdate.body });
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
				const res = await engine.updateNote(indexPath, { content: indexUpdate.body });
				indexWriteOk = res.success ?? true;
				if (!indexWriteOk) failureDetail = `index write refused: ${res.error ?? 'unknown'}`;
			} else {
				indexWriteOk = true;
			}
		} catch (err) {
			failureDetail = `index write threw: ${(err as Error).message}`;
		}
	}

	// ── Rollback on partial failure ────────────────────────────────────────
	if (adrWriteOk && !indexWriteOk && adrUpdate.changed) {
		rollbackAttempted = true;
		try {
			const res = await engine.updateNote(adrPath, { content: adrBody });
			rollbackOk = res.success ?? true;
		} catch {
			rollbackOk = false;
		}
	}

	const allOk = adrWriteOk && indexWriteOk;
	if (allOk) {
		return json({ success: true, applied: true, preview });
	}

	return json(
		{
			success: false,
			applied: adrWriteOk || indexWriteOk,
			rollback_attempted: rollbackAttempted,
			rollback_ok: rollbackOk,
			preview,
			error: failureDetail ?? 'unknown write failure',
		},
		{ status: 500 },
	);
};
