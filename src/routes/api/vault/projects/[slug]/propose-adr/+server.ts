/** POST /api/projects/:slug/propose-adr
 *
 *  project-phases ADR-005 S1 — orchestrator + HTTP surface for the
 *  proposeAdr tool. Thin wrapper around `applyProposeAdr` in
 *  `src/lib/projects/propose-adr.ts` — the same core function the
 *  orchestrator-v2 `proposeAdr` tool calls (S1 manifest entry).
 *
 *  Body: ProposeAdrInput (see schema in propose-adr.ts).
 *
 *  Returns: { success: true, path, ordinal, adr_slug, preview, ... }
 *  Errors:  400 invalid body / unresolved input;
 *           404 if the project's index.md is missing;
 *           409 on two consecutive ordinal collisions. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { applyProposeAdr } from '$lib/projects/propose-adr.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const slug = params.slug;
	if (!slug) return json({ success: false, error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ success: false, error: 'Vault not initialized' }, { status: 503 });

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	// Force the URL's slug to win over any slug in the body — keeps the
	// route + payload aligned and prevents confusion on stale clients.
	const input =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? { ...(raw as Record<string, unknown>), slug }
			: { slug };

	const result = await applyProposeAdr(engine, input);
	const status = result.success ? 201 : (result.status_hint ?? 400);
	return json(result, { status });
};
