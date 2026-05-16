/**
 * Naseej recipe runner (v1).
 *
 * Loads a recipe.yaml, validates referenced components exist in
 * catalog/components/<name>/BLOCK.md, topo-sorts steps by depends_on,
 * interpolates `{{inputs.X}}` and `{{steps.X.outputs.Y}}` placeholders,
 * spawns each component as a subprocess with stdin JSON, captures
 * stdout JSON, propagates exit codes.
 *
 * Step types supported in v1: `component` only. Recipes that need
 * `script` (legacy block format), `agent` (orchestrator-v2 dispatch),
 * or `approval` (durable gates) are out of scope until those primitives
 * ship — see ADR-001 P2.5 + the deferred P0.
 *
 * Runtime detection from BLOCK.md:
 *   runtime: python  → `uv run <path>/run.py`
 *   runtime: node    → `node <path>/run.mjs`
 *
 * Frontmatter parsing + catalog scanning live in `./manifest.ts` so the
 * publish API gates (POST /api/components, POST /api/recipes) share the
 * exact same Zod schema as the runner. Recipe shape validation comes from
 * `./schemas/recipe.ts`.
 */
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { buildCatalogIndex, type ComponentRecord } from './manifest.js';
import {
	isAgentStep,
	isComponentStep,
	parseRecipe,
	type AgentStep,
	type ComponentStep,
	type Recipe,
	type RecipeStep,
} from './schemas/recipe.js';
import { dispatchAgent, type DispatchEvent, type DispatchResult } from '$lib/agents/dispatch/index.js';
import { getAgent } from '$lib/agents/store.js';

const RECIPES_DIR = resolvePath(process.cwd(), 'catalog/recipes');

/** ADR-005 D6 — agent context cap. Bigger context blobs hit the PTY paste-stall
 *  documented in `2026-05-06-pty-paste-stall-and-agent-flag`. */
const MAX_CONTEXT_CHARS = 4000;

/** ADR-005 D5 — last-N event buffer cap per agent step. Bound memory; full
 *  output is already in `output_excerpt`. */
const MAX_EVENT_BUFFER = 50;

/** ADR-005 D7 — agent artifact marker convention. Agents that write a
 *  vault-relative file path between these markers get it surfaced as
 *  `outputs.artifact_path` on the step result. Not a contract — agents
 *  that don't emit the marker simply don't get an artifact pointer. */
const ARTIFACT_MARKER_RE = /===ARTIFACT===\s*\n([^\n]+)\s*\n===END===/;

export type { Recipe, RecipeStep };

export interface StepResult {
	id: string;
	/** Discriminates which branch produced this result; mirrors the recipe step shape. */
	kind: 'component' | 'agent';
	/** Set on component-step results. */
	component?: string;
	/** Set on agent-step results. */
	agent?: string;
	exit_code: number;
	duration_ms: number;
	outputs?: Record<string, unknown>;
	error?: string;
	// ADR-005 — agent-step-only fields. Optional so existing component-step
	// consumers don't break; populated on the agent branch.
	agent_status?: DispatchResult['status'];
	num_turns?: number;
	cost_usd?: number;
	output_excerpt?: string;
	artifact_path?: string;
	events?: DispatchEvent[];
}

export interface RunResult {
	run_id: string;
	recipe: string;
	status: 'success' | 'failed';
	started_at: string;
	finished_at: string;
	duration_ms: number;
	steps: StepResult[];
	failed_step?: string;
}

export async function loadRecipe(recipePath: string): Promise<Recipe> {
	const raw = await readFile(recipePath, 'utf-8');
	const parsed = parseYaml(raw);
	return parseRecipe(parsed);
}

/** Topological sort. Throws on cycles or unknown deps. */
function topoSort(steps: RecipeStep[]): RecipeStep[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const stack = new Set<string>();
	const order: RecipeStep[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		if (stack.has(id)) throw new Error(`cycle detected involving step "${id}"`);
		stack.add(id);
		const step = byId.get(id);
		if (!step) throw new Error(`unknown step id: ${id}`);
		for (const dep of step.depends_on ?? []) {
			if (!byId.has(dep)) throw new Error(`step "${id}" depends on unknown step "${dep}"`);
			visit(dep);
		}
		stack.delete(id);
		visited.add(id);
		order.push(step);
	}

	for (const s of steps) visit(s.id);
	return order;
}

function lookup(expr: string, ctx: Record<string, unknown>): unknown {
	const parts = expr.split('.');
	let cur: unknown = ctx;
	for (const p of parts) {
		if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[p];
		} else {
			return undefined;
		}
	}
	return cur;
}

/** Walk an object/array/string and replace `{{path.to.thing}}` placeholders.
 *  When a string IS a single placeholder (e.g. `"{{inputs.min_score}}"`), the
 *  underlying value's native type is preserved (int stays int, bool stays bool).
 *  Mixed strings (`"hello {{name}}"`) are always concatenated as strings. */
function interpolate(value: unknown, ctx: Record<string, unknown>): unknown {
	if (typeof value === 'string') {
		const wholeMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
		if (wholeMatch) {
			const v = lookup(wholeMatch[1], ctx);
			return v === undefined ? '' : v;
		}
		return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, expr) => {
			const v = lookup(String(expr), ctx);
			if (v === null || v === undefined) return '';
			return typeof v === 'object' ? JSON.stringify(v) : String(v);
		});
	}
	if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, ctx);
		return out;
	}
	return value;
}

/** Spawn a component. Pipes JSON stdin → reads JSON stdout. */
function runComponent(
	record: ComponentRecord,
	stepInputs: Record<string, unknown>,
): Promise<{ exit_code: number; stdout: string; stderr: string; duration_ms: number }> {
	const command = record.manifest.runtime === 'python' ? 'uv' : 'node';
	const args = record.manifest.runtime === 'python' ? ['run', record.entry] : [record.entry];
	return new Promise((resolveP) => {
		const startedAt = Date.now();
		const proc = spawn(command, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: record.dir,
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => {
			resolveP({
				exit_code: code ?? -1,
				stdout,
				stderr,
				duration_ms: Date.now() - startedAt,
			});
		});
		proc.stdin.end(JSON.stringify(stepInputs));
	});
}

function parseOutputs(stdout: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(stdout);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Resolve recipe inputs against operator-supplied values + defaults. */
function resolveInputs(
	recipe: Recipe,
	operator: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const def of recipe.inputs ?? []) {
		if (operator && def.name in operator) {
			out[def.name] = operator[def.name];
		} else if ('default' in def) {
			out[def.name] = def.default;
		} else if (def.required) {
			throw new Error(`required input missing: ${def.name}`);
		}
	}
	// Pass-through unknown operator inputs (forward-compat)
	if (operator) {
		for (const [k, v] of Object.entries(operator)) {
			if (!(k in out)) out[k] = v;
		}
	}
	return out;
}

/** Component-step branch. Extracted so the main runRecipe loop reads as a
 *  thin per-step dispatcher to {component, agent} sub-runners. */
async function runComponentStep(
	step: ComponentStep,
	catalog: Map<string, ComponentRecord>,
	ctx: Record<string, unknown>,
): Promise<StepResult> {
	const manifest = catalog.get(step.component);
	if (!manifest) {
		return {
			id: step.id,
			kind: 'component',
			component: step.component,
			exit_code: -1,
			duration_ms: 0,
			error: `component not found in catalog: ${step.component}`,
		};
	}

	const resolvedInputs = interpolate(step.inputs ?? {}, ctx) as Record<string, unknown>;
	const proc = await runComponent(manifest, resolvedInputs);
	const outputs = parseOutputs(proc.stdout);

	const result: StepResult = {
		id: step.id,
		kind: 'component',
		component: step.component,
		exit_code: proc.exit_code,
		duration_ms: proc.duration_ms,
		outputs,
	};
	if (proc.exit_code !== 0) {
		result.error = outputs?.error ? String(outputs.error) : proc.stderr.trim().slice(0, 500);
	}
	return result;
}

/** Agent-step branch (ADR-005). Drives `dispatchAgent()` for-await, buffers
 *  the last MAX_EVENT_BUFFER events, parses the optional ARTIFACT marker,
 *  maps `DispatchResult.status` to exit-code semantics so the main loop's
 *  halt-on-error treats success+goal_achieved as pass. */
async function runAgentStep(
	step: AgentStep,
	ctx: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<StepResult> {
	const startedAt = Date.now();

	if (!getAgent(step.agent)) {
		return {
			id: step.id,
			kind: 'agent',
			agent: step.agent,
			exit_code: -1,
			duration_ms: Date.now() - startedAt,
			error: `agent not found: ${step.agent}`,
		};
	}

	const task = String(interpolate(step.task, ctx));
	if (!task.trim()) {
		return {
			id: step.id,
			kind: 'agent',
			agent: step.agent,
			exit_code: -1,
			duration_ms: Date.now() - startedAt,
			error: 'agent task resolved to empty after interpolation',
		};
	}

	let context: string | undefined;
	if (step.context != null) {
		const interpolated = String(interpolate(step.context, ctx));
		context = interpolated.length > MAX_CONTEXT_CHARS
			? interpolated.slice(0, MAX_CONTEXT_CHARS)
			: interpolated;
	}

	const goalCondition = step.goal_condition
		? String(interpolate(step.goal_condition, ctx))
		: undefined;

	const events: DispatchEvent[] = [];
	let final: DispatchResult | undefined;
	try {
		const gen = dispatchAgent(step.agent, task, {
			signal,
			context,
			goal_condition: goalCondition,
			budget_override: step.budget,
		});
		while (true) {
			const next = await gen.next();
			if (next.done) {
				final = next.value;
				break;
			}
			events.push(next.value);
			if (events.length > MAX_EVENT_BUFFER) events.shift();
		}
	} catch (err) {
		return {
			id: step.id,
			kind: 'agent',
			agent: step.agent,
			exit_code: -1,
			duration_ms: Date.now() - startedAt,
			error: `dispatcher threw: ${(err as Error).message}`,
			events,
		};
	}

	if (!final) {
		// Defensive — the generator's return value is non-optional per the
		// dispatchAgent contract; this would mean the iterator returned done
		// without a value, which is structurally impossible. Surfaced as a
		// step failure instead of an unhandled exception.
		return {
			id: step.id,
			kind: 'agent',
			agent: step.agent,
			exit_code: -1,
			duration_ms: Date.now() - startedAt,
			error: 'dispatcher returned no final result',
			events,
		};
	}

	const passed = final.status === 'success' || final.status === 'goal_achieved';
	const artifactMatch = final.output.match(ARTIFACT_MARKER_RE);
	const artifactPath = artifactMatch?.[1]?.trim() || undefined;
	const outputExcerpt = final.output.slice(-2000);

	const outputs: Record<string, unknown> = { output_excerpt: outputExcerpt };
	if (artifactPath) outputs.artifact_path = artifactPath;

	const result: StepResult = {
		id: step.id,
		kind: 'agent',
		agent: step.agent,
		exit_code: passed ? 0 : 1,
		duration_ms: final.duration_ms || Date.now() - startedAt,
		outputs,
		agent_status: final.status,
		num_turns: final.num_turns,
		cost_usd: final.cost_usd,
		output_excerpt: outputExcerpt,
		events,
	};
	if (artifactPath) result.artifact_path = artifactPath;
	if (!passed) result.error = final.error || `agent dispatch status: ${final.status}`;
	return result;
}

export async function runRecipe(
	recipePath: string,
	operatorInputs?: Record<string, unknown>,
	opts: { signal?: AbortSignal } = {},
): Promise<RunResult> {
	const recipe = await loadRecipe(recipePath);
	const catalog = await buildCatalogIndex();
	const order = topoSort(recipe.steps);

	// Pre-flight: every component-step references an existing catalog entry,
	// every agent-step references a known agent. Surface as a throw — these
	// are recipe-author errors, not runtime failures.
	for (const step of order) {
		if (isComponentStep(step) && !catalog.has(step.component)) {
			throw new Error(`step "${step.id}" references unknown component: ${step.component}`);
		}
		if (isAgentStep(step) && !getAgent(step.agent)) {
			throw new Error(`step "${step.id}" references unknown agent: ${step.agent}`);
		}
	}

	const runId = randomUUID().slice(0, 8);
	const startedAt = new Date();
	const inputs = resolveInputs(recipe, operatorInputs);
	const ctx: Record<string, unknown> = {
		inputs,
		run_id: runId,
		date: startedAt.toISOString().slice(0, 10),
		project: recipe.project ?? 'naseej',
		steps: {} as Record<string, { outputs: Record<string, unknown> }>,
	};

	const stepsCtx = ctx.steps as Record<string, { outputs: Record<string, unknown> }>;
	const stepResults: StepResult[] = [];
	let failedStep: string | undefined;

	for (const step of order) {
		const stepResult = isAgentStep(step)
			? await runAgentStep(step, ctx, opts.signal)
			: await runComponentStep(step, catalog, ctx);
		stepResults.push(stepResult);
		stepsCtx[step.id] = { outputs: stepResult.outputs ?? {} };
		if (stepResult.exit_code !== 0) {
			failedStep = step.id;
			break;
		}
	}

	const finishedAt = new Date();
	return {
		run_id: runId,
		recipe: recipe.name,
		status: failedStep ? 'failed' : 'success',
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: finishedAt.getTime() - startedAt.getTime(),
		steps: stepResults,
		...(failedStep ? { failed_step: failedStep } : {}),
	};
}

/** Resolve a recipe name (e.g. "hello-naseej") to an absolute path. */
export function recipePathFromName(name: string): string {
	return join(RECIPES_DIR, name, 'recipe.yaml');
}

/** Resolve an arbitrary recipe path safely (must be under catalog/recipes/ or absolute). */
export function resolveRecipePath(input: string): string {
	if (input.includes('..')) throw new Error('recipe path may not contain ..');
	if (input.endsWith('.yaml') || input.endsWith('.yml')) {
		return resolvePath(process.cwd(), input);
	}
	return recipePathFromName(input);
}
