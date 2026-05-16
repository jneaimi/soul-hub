import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runRecipe, resolveRecipePath } from '$lib/naseej/runner.js';
import type { DispatchMode } from '$lib/agents/dispatch/index.js';

/** POST /api/recipes/run — execute a Naseej recipe.
 *
 *  Body: {
 *    recipe: string,                          // name or repo-relative .yaml path
 *    inputs?: Record<string, unknown>,
 *    mode?: 'production' | 'test'             // ADR-005 CP2 — dispatch backend
 *                                             //   for agent steps. Default
 *                                             //   'production' (claude-pty).
 *                                             //   'test' uses claude-cli-flag
 *                                             //   for cheap CI smokes.
 *  }
 *
 *  Response: { run_id, recipe, status, started_at, finished_at, duration_ms, steps, failed_step? }
 *
 *  Status: 200 on success, 422 on failed-run (recipe loaded but a step failed),
 *  400 on bad input, 500 on runner crash.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { recipe, inputs, mode } = (body as Record<string, unknown>) ?? {};
	if (typeof recipe !== 'string' || !recipe) {
		return json({ error: 'recipe (string) is required' }, { status: 400 });
	}
	if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
		return json({ error: 'inputs must be an object' }, { status: 400 });
	}
	if (mode !== undefined && mode !== 'production' && mode !== 'test') {
		return json({ error: 'mode must be "production" or "test"' }, { status: 400 });
	}

	let recipePath: string;
	try {
		recipePath = resolveRecipePath(recipe);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 400 });
	}

	try {
		const result = await runRecipe(
			recipePath,
			inputs as Record<string, unknown> | undefined,
			{ mode: mode as DispatchMode | undefined },
		);
		const status = result.status === 'success' ? 200 : 422;
		return json(result, { status });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
