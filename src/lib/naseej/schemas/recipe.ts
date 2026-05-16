/**
 * Zod schema for Naseej recipe.yaml.
 *
 * Shape grounded in the 2 v1 recipes shipped 2026-05-16:
 *   - catalog/recipes/hello-naseej/recipe.yaml
 *   - catalog/recipes/quality-check-and-log/recipe.yaml
 *
 * Used by:
 *   - src/lib/naseej/runner.ts (loadRecipe — replaces ad-hoc typeof checks)
 *   - src/routes/api/recipes/+server.ts (POST validate gate)
 *
 * Cross-step semantic checks (depends_on resolves to a step id, no cycles,
 * referenced component exists in catalog, version pin satisfiable, project
 * exists in vault) are NOT in the schema — they live in the validator/runner
 * because they need external state.
 */
import { z } from 'zod';

const KebabSlug = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case starting with a letter');

const SemverString = z
	.string()
	.regex(/^\d+\.\d+\.\d+$/, 'must be semver: major.minor.patch');

/** Component reference: `name@version` (pinned) or bare `name` (any version). */
const ComponentRef = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]*(@\d+\.\d+\.\d+)?$/,
		'must be `name` or `name@version` where version is semver',
	);

/** Recipe-level input declaration. */
const RecipeInput = z
	.object({
		name: z.string().min(1, 'input name required'),
		type: z.string().min(1, 'input type required'),
		required: z.boolean().optional(),
		default: z.unknown().optional(),
		description: z.string().optional(),
	})
	.strict();
export type RecipeInput = z.infer<typeof RecipeInput>;

/** Component-flavored step — invokes a subprocess from catalog/components/. */
const ComponentStepSchema = z
	.object({
		id: KebabSlug,
		component: ComponentRef,
		depends_on: z.array(z.string()).optional(),
		inputs: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type ComponentStep = z.infer<typeof ComponentStepSchema>;

/** Agent-flavored step (ADR-005) — invokes a `~/.claude/agents/<id>.md` agent
 *  through `dispatchAgent()`. Budget + goal_condition are optional per-step
 *  overrides; missing fields fall through to the agent's own defaults. */
const AgentStepBudgetSchema = z
	.object({
		timeout_sec: z.number().int().positive().optional(),
		max_turns: z.number().int().positive().optional(),
		max_usd: z.number().nonnegative().optional(),
	})
	.strict();
export type AgentStepBudget = z.infer<typeof AgentStepBudgetSchema>;

const AgentStepSchema = z
	.object({
		id: KebabSlug,
		agent: KebabSlug,
		task: z.string().min(1, 'agent step task may not be empty'),
		context: z.string().optional(),
		budget: AgentStepBudgetSchema.optional(),
		goal_condition: z.string().optional(),
		depends_on: z.array(z.string()).optional(),
	})
	.strict();
export type AgentStep = z.infer<typeof AgentStepSchema>;

/** Recipe step: discriminated by shape — `agent:` or `component:` (exactly
 *  one). Zod's `discriminatedUnion` wants a literal field; we don't want to
 *  burden recipe authors with a `kind:` line when the step shape is already
 *  unambiguous, so we union the two object schemas and rely on `.strict()`
 *  on each plus the superRefine in RecipeSchema to enforce mutual exclusion
 *  AND that one of them is present. */
const RecipeStepSchema = z.union([ComponentStepSchema, AgentStepSchema]);
export type RecipeStep = ComponentStep | AgentStep;

/** Type guard — runner uses this to pick the dispatch branch. */
export function isAgentStep(step: RecipeStep): step is AgentStep {
	return 'agent' in step;
}

/** Type guard — runner uses this to pick the dispatch branch. */
export function isComponentStep(step: RecipeStep): step is ComponentStep {
	return 'component' in step;
}

/** Full recipe.yaml schema. ADR-003 requires `project:` so it's required here. */
export const RecipeSchema = z
	.object({
		name: KebabSlug,
		version: SemverString,
		project: KebabSlug,
		description: z.string().optional(),
		inputs: z.array(RecipeInput).default([]),
		steps: z.array(RecipeStepSchema).min(1, 'recipe must have at least one step'),
	})
	.passthrough()
	.superRefine((v, ctx) => {
		// Step ids unique
		const ids = v.steps.map((s) => s.id);
		const dup = ids.find((id, i) => ids.indexOf(id) !== i);
		if (dup) {
			ctx.addIssue({
				code: 'custom',
				path: ['steps'],
				message: `duplicate step id: "${dup}"`,
			});
		}
		// depends_on targets resolve to known step ids
		const idSet = new Set(ids);
		v.steps.forEach((step, i) => {
			for (const dep of step.depends_on ?? []) {
				if (!idSet.has(dep)) {
					ctx.addIssue({
						code: 'custom',
						path: ['steps', i, 'depends_on'],
						message: `step "${step.id}" depends on unknown step "${dep}"`,
					});
				}
			}
		});
		// Recipe input names unique
		const inputNames = (v.inputs ?? []).map((i) => i.name);
		const inputDup = inputNames.find((n, i) => inputNames.indexOf(n) !== i);
		if (inputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['inputs'],
				message: `duplicate input name: "${inputDup}"`,
			});
		}
	});

export type Recipe = z.infer<typeof RecipeSchema>;

/** Parse a component reference into `{ name, version | null }`. */
export function parseComponentRef(ref: string): { name: string; version: string | null } {
	const idx = ref.indexOf('@');
	if (idx === -1) return { name: ref, version: null };
	return { name: ref.slice(0, idx), version: ref.slice(idx + 1) };
}

/** Parse + validate. Throws ZodError on failure. */
export function parseRecipe(raw: unknown): Recipe {
	return RecipeSchema.parse(raw);
}

/** Parse + validate. Returns `{ ok: true, data }` or `{ ok: false, errors }`. */
export function safeParseRecipe(
	raw: unknown,
): { ok: true; data: Recipe } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = RecipeSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}
