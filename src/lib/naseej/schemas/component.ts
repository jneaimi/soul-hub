/**
 * Zod schema for Naseej component BLOCK.md frontmatter.
 *
 * Shape grounded in the 3 v1 components shipped 2026-05-16:
 *   - catalog/components/stop-slop/BLOCK.md      (runtime: python)
 *   - catalog/components/vault-write/BLOCK.md    (runtime: node)
 *   - catalog/components/channel-send-text/BLOCK.md (runtime: node)
 *
 * Used by:
 *   - src/lib/naseej/manifest.ts (parsing + tolerant listing)
 *   - src/routes/api/components/+server.ts (GET listing + POST validate gate)
 *   - src/lib/naseej/runner.ts (loadCatalog)
 *
 * Forward-compat rules:
 *   - Extra unknown keys are allowed at the top level (strip)
 *   - Input/output `type` is open-string (forward-compat for new primitive types)
 *   - `runtime` is enum: extending requires schema + runner change in lockstep
 */
import { z } from 'zod';

/** Kebab-case slug, must start with a letter. Used for component name + step ids. */
const KebabSlug = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case starting with a letter');

/** Semver shape: major.minor.patch (no pre-release / build metadata in v1). */
const SemverString = z
	.string()
	.regex(/^\d+\.\d+\.\d+$/, 'must be semver: major.minor.patch');

/** Allowed runtimes — extending requires updating the runner's spawn dispatch. */
export const RuntimeEnum = z.enum(['python', 'node']);
export type Runtime = z.infer<typeof RuntimeEnum>;

/** Input field. Mirrors what BLOCK.md declares per input. */
const InputField = z
	.object({
		name: z.string().min(1, 'input name required'),
		type: z.string().min(1, 'input type required'),
		required: z.boolean().optional(),
		default: z.unknown().optional(),
		enum: z.array(z.unknown()).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		description: z.string().optional(),
	})
	.strict();
export type InputField = z.infer<typeof InputField>;

/** Output field. Less constrained than inputs (no required/default semantics). */
const OutputField = z
	.object({
		name: z.string().min(1, 'output name required'),
		type: z.string().min(1, 'output type required'),
		enum: z.array(z.unknown()).optional(),
		description: z.string().optional(),
	})
	.strict();
export type OutputField = z.infer<typeof OutputField>;

/** Invocation contract. v1 only supports stdin-json. */
const Invocation = z
	.object({
		protocol: z.literal('stdin-json'),
		request: z.string().optional(),
		response: z.string().optional(),
		exit_codes: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type Invocation = z.infer<typeof Invocation>;

/** Full BLOCK.md frontmatter schema. */
export const ComponentManifestSchema = z
	.object({
		name: KebabSlug,
		version: SemverString,
		type: z.literal('component').optional(),
		category: z.string().optional(),
		runtime: RuntimeEnum.default('node'),
		description: z.string().optional(),
		author: z.string().optional(),
		project: z.string().optional(),
		/** ADR-006 D4 — two-tier catalog model. Tier 1: capability (generic
		 *  protocol-shaped, configured per use-case, e.g. `shell-exec`). Tier 2:
		 *  domain adapter (typed wrapper over an external system, e.g.
		 *  `katib-build`, `vault-write`). Defaults to 2 so existing components
		 *  pre-ADR-006 keep parsing without migration. */
		tier: z.union([z.literal(1), z.literal(2)]).default(2),
		/** ADR-023 — component shape discriminator. `default` (most components:
		 *  passive subprocess with exit 0/non-zero, no pause). `agentic` (UI hint:
		 *  surfaces agent-style metadata; e.g. `agent-dispatch`). `gate` (runner
		 *  applies the stdout-code-2 pause-intercept protocol; required for
		 *  `human-form` + `approval-gate`). Default preserves pre-ADR-023 behaviour. */
		shape: z.enum(['default', 'agentic', 'gate']).default('default'),
		inputs: z.array(InputField).default([]),
		outputs: z.array(OutputField).default([]),
		invocation: Invocation.optional(),
	})
	.passthrough()
	.superRefine((v, ctx) => {
		const inputNames = (v.inputs ?? []).map((i) => i.name);
		const inputDup = inputNames.find((n, i) => inputNames.indexOf(n) !== i);
		if (inputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['inputs'],
				message: `duplicate input name: "${inputDup}"`,
			});
		}
		const outputNames = (v.outputs ?? []).map((o) => o.name);
		const outputDup = outputNames.find((n, i) => outputNames.indexOf(n) !== i);
		if (outputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['outputs'],
				message: `duplicate output name: "${outputDup}"`,
			});
		}
	});

export type ComponentManifest = z.infer<typeof ComponentManifestSchema>;

/** Parse + validate. Throws ZodError on failure. */
export function parseComponentManifest(raw: unknown): ComponentManifest {
	return ComponentManifestSchema.parse(raw);
}

/** Parse + validate. Returns `{ ok: true, data }` or `{ ok: false, error }`. */
export function safeParseComponentManifest(
	raw: unknown,
): { ok: true; data: ComponentManifest } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = ComponentManifestSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}
