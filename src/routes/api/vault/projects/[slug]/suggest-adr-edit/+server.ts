/** POST /api/vault/projects/:slug/suggest-adr-edit
 *
 *  project-phases ADR-005 S3 — orchestrator + HTTP surface for the
 *  suggestAdrEdit tool. Thin wrapper around `applyProposeAdrEdit` in
 *  `src/lib/projects/suggest-adr-edit.ts`.
 *
 *  Body: SuggestAdrEditInput (see schema in suggest-adr-edit.ts).
 *
 *  Returns: { success: true, path, filename, target_adr, section }
 *  Errors:  400 invalid body / unresolved adr;
 *           404 if the project's index.md is missing. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { applyProposeAdrEdit } from '$lib/projects/suggest-adr-edit.js';

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

	const input =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? { ...(raw as Record<string, unknown>), slug }
			: { slug };

	const result = await applyProposeAdrEdit(engine, input);
	const status = result.success ? 201 : (result.status_hint ?? 400);
	return json(result, { status });
};
