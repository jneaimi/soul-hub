import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runRecipe, resolveRecipePath } from '$lib/naseej/runner.js';

/** POST /api/recipes/run — execute a Naseej recipe.
 *
 *  Body: { recipe: string, inputs?: Record<string, unknown> }
 *    `recipe` is either a recipe name (resolves to catalog/recipes/<name>/recipe.yaml)
 *    or a repo-relative .yaml/.yml path.
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
	const { recipe, inputs } = (body as Record<string, unknown>) ?? {};
	if (typeof recipe !== 'string' || !recipe) {
		return json({ error: 'recipe (string) is required' }, { status: 400 });
	}
	if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
		return json({ error: 'inputs must be an object' }, { status: 400 });
	}

	let recipePath: string;
	try {
		recipePath = resolveRecipePath(recipe);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 400 });
	}

	try {
		const result = await runRecipe(recipePath, inputs as Record<string, unknown> | undefined);
		const status = result.status === 'success' ? 200 : 422;
		return json(result, { status });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
