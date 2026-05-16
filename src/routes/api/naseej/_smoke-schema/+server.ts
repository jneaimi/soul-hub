/**
 * Temporary smoke endpoint for the ADR-005 CP1 recipe schema changes.
 *
 * Runs an in-process suite over `safeParseRecipe` covering:
 *   - component-only recipe (existing path, regression check)
 *   - agent-only recipe (new path)
 *   - mixed recipe (the eventual real-world shape)
 *   - both-fields-on-one-step rejection (mutual exclusion)
 *   - neither-field-on-one-step rejection
 *   - empty agent task rejection
 *   - depends_on across step kinds resolves
 *   - partial budget override accepted
 *
 * Why a temp route and not a node script: per
 * `feedback_no_raw_node_for_sveltekit_lib_smoke`, SvelteKit `.js`-suffix imports
 * don't resolve under raw Node ESM. Trust the build for type correctness; use a
 * `+server.ts` for behavioural smoke. Curl this route, then delete the file once
 * CP1 ships.
 *
 *   curl -s http://localhost:2400/api/naseej/_smoke-schema | jq .
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { safeParseRecipe, isAgentStep, isComponentStep } from '$lib/naseej/schemas/recipe.js';

interface Case {
	name: string;
	expect: 'pass' | 'fail';
	run: () => boolean;
	error?: string;
}

function expectPass(raw: unknown): { ok: boolean; error?: string } {
	const result = safeParseRecipe(raw);
	if (!result.ok) {
		return { ok: false, error: JSON.stringify(result.errors.slice(0, 3)) };
	}
	return { ok: true };
}

function expectFail(raw: unknown, mustContain?: string): { ok: boolean; error?: string } {
	const result = safeParseRecipe(raw);
	if (result.ok) return { ok: false, error: 'expected fail but parsed cleanly' };
	if (mustContain) {
		const blob = JSON.stringify(result.errors);
		if (!blob.includes(mustContain)) {
			return { ok: false, error: `expected error to mention "${mustContain}", got: ${blob.slice(0, 300)}` };
		}
	}
	return { ok: true };
}

const cases: Case[] = [
	{
		name: '1) component-only recipe (regression)',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-regression',
				version: '1.0.0',
				project: 'naseej',
				steps: [{ id: 'a', component: 'stop-slop@1.0.0', inputs: { text: 'hi' } }],
			}).ok,
	},
	{
		name: '2) agent-only recipe parses',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-agent-only',
				version: '1.0.0',
				project: 'naseej',
				steps: [{ id: 'review', agent: 'inspector', task: 'lint the file' }],
			}).ok,
	},
	{
		name: '3) mixed recipe (component + agent)',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-mixed',
				version: '1.0.0',
				project: 'naseej',
				steps: [
					{ id: 'score', component: 'stop-slop@1.0.0', inputs: { text: 'hi' } },
					{ id: 'review', agent: 'inspector', task: 'check', depends_on: ['score'] },
				],
			}).ok,
	},
	{
		name: '4) reject step with BOTH agent + component (mutual exclusion)',
		expect: 'fail',
		run: () =>
			expectFail({
				name: 'cp1-both',
				version: '1.0.0',
				project: 'naseej',
				steps: [{ id: 'bad', component: 'stop-slop', agent: 'inspector', task: 't' }],
			}).ok,
	},
	{
		name: '5) reject step with NEITHER agent nor component',
		expect: 'fail',
		run: () =>
			expectFail({
				name: 'cp1-neither',
				version: '1.0.0',
				project: 'naseej',
				steps: [{ id: 'bad' }],
			}).ok,
	},
	{
		name: '6) reject agent step with empty task',
		expect: 'fail',
		run: () =>
			expectFail(
				{
					name: 'cp1-empty-task',
					version: '1.0.0',
					project: 'naseej',
					steps: [{ id: 'bad', agent: 'inspector', task: '' }],
				},
				'task may not be empty',
			).ok,
	},
	{
		name: '7) depends_on resolves across kinds',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-cross-kind-deps',
				version: '1.0.0',
				project: 'naseej',
				steps: [
					{ id: 'first', agent: 'researcher', task: 'gather' },
					{ id: 'second', component: 'stop-slop@1.0.0', depends_on: ['first'], inputs: {} },
				],
			}).ok,
	},
	{
		name: '8) reject depends_on pointing at unknown step',
		expect: 'fail',
		run: () =>
			expectFail(
				{
					name: 'cp1-bad-dep',
					version: '1.0.0',
					project: 'naseej',
					steps: [{ id: 'a', agent: 'inspector', task: 't', depends_on: ['nope'] }],
				},
				'depends on unknown step',
			).ok,
	},
	{
		name: '9) partial budget override accepted',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-partial-budget',
				version: '1.0.0',
				project: 'naseej',
				steps: [
					{
						id: 'long',
						agent: 'researcher',
						task: 't',
						budget: { timeout_sec: 600 },
					},
				],
			}).ok,
	},
	{
		name: '10) goal_condition + context fields accepted',
		expect: 'pass',
		run: () =>
			expectPass({
				name: 'cp1-goal-and-context',
				version: '1.0.0',
				project: 'naseej',
				steps: [
					{
						id: 'verify',
						agent: 'inspector',
						task: 'run tests',
						context: '{{inputs.brief}}',
						goal_condition: 'all tests pass',
					},
				],
			}).ok,
	},
	{
		name: '11) type guards classify each step kind correctly',
		expect: 'pass',
		run: () => {
			const parsed = safeParseRecipe({
				name: 'cp1-guards',
				version: '1.0.0',
				project: 'naseej',
				steps: [
					{ id: 'c', component: 'stop-slop', inputs: {} },
					{ id: 'a', agent: 'inspector', task: 't' },
				],
			});
			if (!parsed.ok) return false;
			const [s1, s2] = parsed.data.steps;
			return isComponentStep(s1) && !isAgentStep(s1) && isAgentStep(s2) && !isComponentStep(s2);
		},
	},
	{
		name: '12) reject extra fields on agent step (strict)',
		expect: 'fail',
		run: () =>
			expectFail({
				name: 'cp1-strict-agent',
				version: '1.0.0',
				project: 'naseej',
				steps: [{ id: 'bad', agent: 'inspector', task: 't', mystery: 'oops' }],
			}).ok,
	},
];

export const GET: RequestHandler = async () => {
	const results = cases.map((c) => {
		try {
			const ok = c.run();
			return { name: c.name, expect: c.expect, status: ok ? 'pass' : 'fail' };
		} catch (err) {
			return {
				name: c.name,
				expect: c.expect,
				status: 'error',
				error: (err as Error).message,
			};
		}
	});
	const summary = {
		total: results.length,
		passed: results.filter((r) => r.status === 'pass').length,
		failed: results.filter((r) => r.status === 'fail').length,
		errored: results.filter((r) => r.status === 'error').length,
	};
	return json({ summary, results });
};
