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
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { buildCatalogIndex, type ComponentRecord } from './manifest.js';
import {
	isAgentStep,
	isComponentStep,
	isFileInput,
	parseRecipe,
	type AgentStep,
	type ComponentStep,
	type Recipe,
	type RecipeStep,
} from './schemas/recipe.js';
import {
	dispatchAgent,
	type DispatchEvent,
	type DispatchMode,
	type DispatchResult,
} from '$lib/agents/dispatch/index.js';
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

/** ADR-006 D3 — exhaustive filter set. Unknown filter throws; no extensibility
 *  surface today. Filters compose left-to-right via the pipe operator. */
const FILTERS: Record<string, (val: unknown, arg?: string) => unknown> = {
	basename: (v) => basename(String(v ?? '')),
	dirname: (v) => dirname(String(v ?? '')),
	human_bytes: (v) => {
		const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
		if (!Number.isFinite(n)) return String(v ?? '');
		if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
		if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
		if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
		return `${n}B`;
	},
	date_fmt: (v, arg) => {
		const s = String(v ?? '');
		if (!arg) return s;
		const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return s;
		const [, year, month, day] = m;
		return arg
			.replace(/YYYY/g, year)
			.replace(/MM/g, month)
			.replace(/DD/g, day);
	},
};

/** Apply a single filter expression like `"basename"` or `"date_fmt:DD/MM/YYYY"`.
 *  Throws on unknown filter — typos shouldn't silently no-op. */
function applyFilter(value: unknown, filterExpr: string): unknown {
	const colonIdx = filterExpr.indexOf(':');
	const name = (colonIdx >= 0 ? filterExpr.slice(0, colonIdx) : filterExpr).trim();
	const arg = colonIdx >= 0 ? filterExpr.slice(colonIdx + 1).trim() : undefined;
	const fn = FILTERS[name];
	if (!fn) {
		throw new Error(
			`unknown templating filter: "${name}". Known filters: ${Object.keys(FILTERS).join(', ')}`,
		);
	}
	return fn(value, arg);
}

/** Evaluate a `{{ expr | filter1 | filter2:arg }}` placeholder body against ctx. */
function evaluateExpr(raw: string, ctx: Record<string, unknown>): unknown {
	const parts = raw.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
	if (parts.length === 0) return undefined;
	let cur: unknown = lookup(parts[0], ctx);
	for (let i = 1; i < parts.length; i++) cur = applyFilter(cur, parts[i]);
	return cur;
}

/** Walk an object/array/string and replace `{{path.to.thing | filter}}` placeholders.
 *  When a string IS a single placeholder (e.g. `"{{inputs.min_score}}"`), the
 *  underlying value's native type is preserved (int stays int, bool stays bool).
 *  Mixed strings (`"hello {{name}}"`) are always concatenated as strings.
 *
 *  ADR-006 D3 — filter pipe syntax: `{{ x | basename }}` and
 *  `{{ x | date_fmt:DD/MM/YYYY }}` are supported. Unknown filters throw. */
function interpolate(value: unknown, ctx: Record<string, unknown>): unknown {
	if (typeof value === 'string') {
		const wholeMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
		if (wholeMatch) {
			const v = evaluateExpr(wholeMatch[1], ctx);
			return v === undefined ? '' : v;
		}
		return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, expr) => {
			const v = evaluateExpr(String(expr), ctx);
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

/** Resolve recipe inputs against operator-supplied values + defaults.
 *
 *  ADR-006 D1 — typed inputs. `file` inputs interpolate their `path:` template
 *  against the partial ctx (`ctxBase` + inputs resolved so far) and optionally
 *  fail fast if `must_exist: true` and the file is missing. Non-file inputs use
 *  the existing operator-or-default-or-required pipeline.
 *
 *  Declaration order matters — a `file` input's `path:` may reference earlier
 *  inputs (e.g. `{{inputs.date}}`). */
function resolveInputs(
	recipe: Recipe,
	operator: Record<string, unknown> | undefined,
	ctxBase: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const def of recipe.inputs ?? []) {
		const partialCtx = { ...ctxBase, inputs: out };
		if (isFileInput(def)) {
			const resolvedPath = String(interpolate(def.path, partialCtx));
			if (def.must_exist && !existsSync(resolvedPath)) {
				throw new Error(
					`input "${def.name}" file does not exist: ${resolvedPath}`,
				);
			}
			out[def.name] = resolvedPath;
		} else if (operator && def.name in operator) {
			out[def.name] = operator[def.name];
		} else if ('default' in def) {
			// ADR-006 S2 — defaults may contain templates (e.g. `"{{HOME}}/Downloads/..."`).
			// Interpolated against ctxBase + inputs resolved so far. v1 recipes used
			// literal defaults; that path still works (interpolate is a no-op on
			// strings without `{{ }}` markers).
			out[def.name] = interpolate(def.default, partialCtx);
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
 *  halt-on-error treats success+goal_achieved as pass.
 *
 *  `mode` controls which dispatch backend handles the agent. 'production'
 *  (default) routes through claude-pty; 'test' routes through claude-cli-flag
 *  for cheaper/faster CI smokes (no PTY, single-shot). */
async function runAgentStep(
	step: AgentStep,
	ctx: Record<string, unknown>,
	signal: AbortSignal | undefined,
	mode: DispatchMode,
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
			mode,
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

export interface RunRecipeOptions {
	signal?: AbortSignal;
	/** ADR-005 CP2 — dispatch backend selector for agent steps.
	 *  'production' (default) uses claude-pty; 'test' uses claude-cli-flag
	 *  for CI smokes (no PTY, no terminal, single-shot). Component steps
	 *  are unaffected — they spawn subprocesses regardless. */
	mode?: DispatchMode;
	/** ADR-005 CP3 — opt-in caller-supplied runId. When provided, replaces
	 *  the auto-generated short-id. Lets the caller register a cancel hook
	 *  via POST /api/recipes/runs/<id>/cancel before the run completes.
	 *  When omitted, an 8-char UUID slice is generated and only known
	 *  after the run finishes (legacy CP1+CP2 behaviour). */
	runId?: string;
}

/** ADR-005 CP3 — in-flight run registry. Each in-progress runRecipe call
 *  registers an AbortController here keyed on its runId; the cancel
 *  endpoint (POST /api/recipes/runs/[run_id]/cancel) calls cancelRun()
 *  to fire it. Entries are deleted in the runRecipe finally block.
 *
 *  Single in-process Map — there is no recipe runner outside the
 *  soul-hub process, and crashes drop the registry which is correct
 *  (a crashed run cannot be cancelled, only restarted). */
const runRegistry = new Map<string, AbortController>();

/** Fire the AbortController for an in-flight run. Returns true if the
 *  run existed in the registry (cancel signal sent); false if no such
 *  run is currently in-flight (already finished, never started, or
 *  the caller used the wrong runId). */
export function cancelRun(runId: string): boolean {
	const controller = runRegistry.get(runId);
	if (!controller) return false;
	controller.abort();
	return true;
}

/** Inspect the live registry. Used by the cancel endpoint to return
 *  meaningful 404 vs "active" diagnostics. Returns the runIds currently
 *  registered (snapshot, not live). */
export function listActiveRuns(): string[] {
	return [...runRegistry.keys()];
}

export async function runRecipe(
	recipePath: string,
	operatorInputs?: Record<string, unknown>,
	opts: RunRecipeOptions = {},
): Promise<RunResult> {
	const recipe = await loadRecipe(recipePath);
	const catalog = await buildCatalogIndex();
	const order = topoSort(recipe.steps);
	const mode: DispatchMode = opts.mode ?? 'production';

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

	const runId = opts.runId ?? randomUUID().slice(0, 8);
	const startedAt = new Date();
	// ADR-006 D2 — ctxBase carries context globals available DURING input
	// resolution (so a `file` input's `path:` template can reference `{{date}}`,
	// `{{HOME}}`, `{{work_dir}}`). work_dir is materialised below before any
	// step runs; cleanup is deferred to a separate retention job (out of scope).
	const workDir = join(homedir(), '.soul-hub', 'data', 'naseej', 'runs', runId);
	const ctxBase = {
		run_id: runId,
		date: startedAt.toISOString().slice(0, 10),
		project: recipe.project ?? 'naseej',
		HOME: homedir(),
		work_dir: workDir,
	};
	const inputs = resolveInputs(recipe, operatorInputs, ctxBase);
	await mkdir(workDir, { recursive: true });
	const ctx: Record<string, unknown> = {
		...ctxBase,
		inputs,
		steps: {} as Record<string, { outputs: Record<string, unknown> }>,
	};

	// ADR-005 CP3 — register an AbortController for this run so the cancel
	// endpoint can fire it. If the caller already passed opts.signal, chain
	// it into the same controller so either side can trigger cancellation.
	const controller = new AbortController();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
	}
	runRegistry.set(runId, controller);

	const stepsCtx = ctx.steps as Record<string, { outputs: Record<string, unknown> }>;
	const stepResults: StepResult[] = [];
	let failedStep: string | undefined;

	try {
		for (const step of order) {
			const stepResult = isAgentStep(step)
				? await runAgentStep(step, ctx, controller.signal, mode)
				: await runComponentStep(step, catalog, ctx);
			stepResults.push(stepResult);
			stepsCtx[step.id] = { outputs: stepResult.outputs ?? {} };
			if (stepResult.exit_code !== 0) {
				failedStep = step.id;
				break;
			}
		}
	} finally {
		runRegistry.delete(runId);
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
