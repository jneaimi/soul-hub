/**
 * Shared condition evaluation for pipeline steps and chain nodes.
 * Supports: ==, !=, contains, not_contains
 */

type Operator = '==' | '!=' | 'contains' | 'not_contains';

interface ParsedCondition {
	left: string;
	op: Operator;
	right: string;
}

/** Parse a condition expression into its components */
export function parseCondition(expr: string): ParsedCondition {
	const operators: Operator[] = ['not_contains', 'contains', '!=', '=='];

	for (const candidate of operators) {
		const idx = expr.indexOf(` ${candidate} `);
		if (idx !== -1) {
			return {
				left: expr.substring(0, idx).trim(),
				op: candidate,
				right: expr.substring(idx + candidate.length + 2).trim().replace(/^["']|["']$/g, ''),
			};
		}
	}

	throw new Error(`Invalid condition expression: "${expr}". Use ==, !=, contains, or not_contains`);
}

/** Evaluate a parsed condition given a resolved left-side value */
export function evaluateConditionOp(resolvedLeft: string, op: Operator, right: string): boolean {
	switch (op) {
		case '==': return resolvedLeft === right;
		case '!=': return resolvedLeft !== right;
		case 'contains': return resolvedLeft.includes(right);
		case 'not_contains': return !resolvedLeft.includes(right);
		default: throw new Error(`Unsupported operator: ${op}`);
	}
}
