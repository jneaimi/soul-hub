import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import type { PipelineSpec } from './types.js';

/** Parse a pipeline YAML file and validate its structure */
export async function parsePipeline(filePath: string): Promise<PipelineSpec> {
	const raw = await readFile(filePath, 'utf-8');
	const spec = parseYaml(raw) as PipelineSpec;

	// Validate required fields
	if (!spec.name) throw new Error('Pipeline missing "name"');
	if (!spec.steps || !Array.isArray(spec.steps) || spec.steps.length === 0) {
		throw new Error('Pipeline must have at least one step');
	}

	for (const step of spec.steps) {
		if (!step.id) throw new Error('Every step must have an "id"');
		if (!step.type) throw new Error(`Step "${step.id}" missing "type"`);

		// approval and prompt steps don't produce files — output is never required
		if (step.type === 'approval' || step.type === 'prompt') {
			if (!step.output) step.output = '/dev/null';
		} else {
			// output is required for file/media/response types, optional for action/webhook
			const outputType = step.output_type || 'file';
			if (!step.output && (outputType === 'file' || outputType === 'media' || outputType === 'response')) {
				throw new Error(`Step "${step.id}" missing "output" (required for ${outputType} output_type)`);
			}
			if (!step.output) step.output = '/dev/null';
		}

		if (step.type === 'script' && !step.run) {
			throw new Error(`Script step "${step.id}" missing "run" command`);
		}
		if (step.type === 'agent' && !step.agent) {
			throw new Error(`Agent step "${step.id}" missing "agent" name`);
		}

		// Validate depends_on references
		if (step.depends_on) {
			const stepIds = new Set(spec.steps.map((s) => s.id));
			for (const dep of step.depends_on) {
				if (!stepIds.has(dep)) {
					throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
				}
			}
		}
	}

	// Check for circular dependencies
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const stepMap = new Map(spec.steps.map((s) => [s.id, s]));

	function checkCycle(id: string): void {
		if (visiting.has(id)) throw new Error(`Circular dependency detected at step "${id}"`);
		if (visited.has(id)) return;

		visiting.add(id);
		const step = stepMap.get(id)!;
		for (const dep of step.depends_on || []) {
			checkCycle(dep);
		}
		visiting.delete(id);
		visited.add(id);
	}

	for (const step of spec.steps) {
		checkCycle(step.id);
	}

	return spec;
}

/** Resolve variable references in a string: $inputs.X, $steps.X.output */
export function resolveRef(
	value: string,
	inputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
): string {
	return value.replace(/\$inputs\.([\w-]+)/g, (_, name) => {
		const val = inputs[name];
		if (val === undefined) throw new Error(`Unknown input reference: $inputs.${name}`);
		return String(val);
	}).replace(/\$steps\.([\w-]+)\.output/g, (_, stepId) => {
		const val = stepOutputs[stepId];
		if (val === undefined) throw new Error(`Unknown step output reference: $steps.${stepId}.output`);
		return val;
	});
}

/**
 * Evaluate a condition expression against resolved values.
 * Supports: ==, !=, contains, not_contains
 * Example: '$steps.choose-lang.output == "English"'
 * Returns true if the condition is met.
 */
export function evaluateCondition(
	expr: string,
	inputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
): boolean {
	// Parse the expression: left operator right
	const operators = ['not_contains', 'contains', '!=', '=='] as const;
	let left = '';
	let op = '' as typeof operators[number];
	let right = '';

	for (const candidate of operators) {
		const idx = expr.indexOf(` ${candidate} `);
		if (idx !== -1) {
			left = expr.substring(0, idx).trim();
			op = candidate;
			right = expr.substring(idx + candidate.length + 2).trim();
			break;
		}
	}

	if (!op) {
		throw new Error(`Invalid condition expression: "${expr}". Use ==, !=, contains, or not_contains`);
	}

	// Resolve variable references on the left side
	const resolvedLeft = resolveRef(left, inputs, stepOutputs);

	// Strip quotes from the right side
	const resolvedRight = right.replace(/^["']|["']$/g, '');

	switch (op) {
		case '==': return resolvedLeft === resolvedRight;
		case '!=': return resolvedLeft !== resolvedRight;
		case 'contains': return resolvedLeft.includes(resolvedRight);
		case 'not_contains': return !resolvedLeft.includes(resolvedRight);
	}
}

/**
 * Check if a step should be skipped based on when/skip_if conditions.
 * Returns { skip: false } if the step should run, or { skip: true, reason: '...' } if skipped.
 */
export function checkCondition(
	step: { when?: string; skip_if?: string; id: string },
	inputs: Record<string, string | number>,
	stepOutputs: Record<string, string>,
): { skip: boolean; reason?: string } {
	if (step.when) {
		const result = evaluateCondition(step.when, inputs, stepOutputs);
		if (!result) {
			return { skip: true, reason: `when: ${step.when}` };
		}
	}
	if (step.skip_if) {
		const result = evaluateCondition(step.skip_if, inputs, stepOutputs);
		if (result) {
			return { skip: true, reason: `skip_if: ${step.skip_if}` };
		}
	}
	return { skip: false };
}

/** Get execution order respecting depends_on (topological sort) */
export function getExecutionOrder(spec: PipelineSpec): string[] {
	const order: string[] = [];
	const visited = new Set<string>();
	const stepMap = new Map(spec.steps.map((s) => [s.id, s]));

	function visit(id: string) {
		if (visited.has(id)) return;
		const step = stepMap.get(id)!;
		for (const dep of step.depends_on || []) {
			visit(dep);
		}
		visited.add(id);
		order.push(id);
	}

	for (const step of spec.steps) {
		visit(step.id);
	}

	return order;
}
