import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listAgents, writeAgent, getAgent, bumpStoreVersion, getStoreVersion } from '$lib/agents/store.js';
import { AgentDraftSchema } from '$lib/agents/types.js';

/** GET /api/agents — list all agents across Lane A + Lane B. */
export const GET: RequestHandler = async () => {
	const result = listAgents();
	return json({
		agents: result.agents,
		laneADir: result.laneADir,
		laneBDir: result.laneBDir,
		errors: result.errors,
		version: getStoreVersion(),
	});
};

/** POST /api/agents — create a new agent.
 *
 *  Body must satisfy `AgentDraftSchema`. Refuses to overwrite an existing
 *  agent (PUT for that). Returns the persisted record on success. */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const parsed = AgentDraftSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ error: 'validation failed', issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const draft = parsed.data;
	if (getAgent(draft.id)) {
		return json(
			{ error: `agent already exists: ${draft.id}` },
			{ status: 409 },
		);
	}

	try {
		const path = writeAgent(draft);
		bumpStoreVersion();
		const saved = getAgent(draft.id);
		return json({ agent: saved, path }, { status: 201 });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
