import { parse as parseYaml } from 'yaml';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parsePipeline } from './parser.js';
import type { ChainSpec } from './chain-types.js';

/** Parse a chain YAML file and validate its structure */
export async function parseChain(filePath: string): Promise<ChainSpec> {
	const raw = await readFile(filePath, 'utf-8');
	const spec = parseYaml(raw) as ChainSpec;
	const pipelinesDir = resolve(dirname(filePath), '..');

	// Validate required fields
	if (!spec.name) throw new Error('Chain missing "name"');
	if (spec.type !== 'chain') throw new Error('Chain missing "type: chain"');
	if (!spec.nodes || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
		throw new Error('Chain must have at least one node');
	}

	const nodeIds = new Set<string>();
	for (const node of spec.nodes) {
		if (!node.id) throw new Error('Every node must have an "id"');
		if (!node.pipeline) throw new Error(`Node "${node.id}" missing "pipeline"`);
		if (nodeIds.has(node.id)) throw new Error(`Duplicate node ID "${node.id}"`);
		nodeIds.add(node.id);
	}

	// Validate pipeline references exist and reject nested chains
	for (const node of spec.nodes) {
		const pipelineYaml = resolve(pipelinesDir, node.pipeline, 'pipeline.yaml');
		const chainYaml = resolve(pipelinesDir, node.pipeline, 'chain.yaml');

		// Check for nested chain reference first
		let isChain = false;
		try { await access(chainYaml); isChain = true; } catch { /* not a chain */ }
		if (isChain) {
			throw new Error(`Node "${node.id}" references chain "${node.pipeline}" — chains cannot reference other chains`);
		}

		// Check pipeline exists
		try {
			await access(pipelineYaml);
		} catch {
			throw new Error(`Node "${node.id}" references pipeline "${node.pipeline}" which does not exist in pipelines/`);
		}
	}

	// Validate depends_on references
	for (const node of spec.nodes) {
		for (const dep of node.depends_on || []) {
			if (!nodeIds.has(dep)) {
				throw new Error(`Node "${node.id}" depends on unknown node "${dep}"`);
			}
		}
	}

	// Check for circular dependencies (DFS)
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const nodeMap = new Map(spec.nodes.map((n) => [n.id, n]));

	function checkCycle(id: string): void {
		if (visiting.has(id)) throw new Error(`Circular dependency detected at node "${id}"`);
		if (visited.has(id)) return;

		visiting.add(id);
		const node = nodeMap.get(id)!;
		for (const dep of node.depends_on || []) {
			checkCycle(dep);
		}
		visiting.delete(id);
		visited.add(id);
	}

	for (const node of spec.nodes) {
		checkCycle(node.id);
	}

	// Validate input mappings
	const chainInputNames = new Set((spec.inputs || []).map((i) => i.name));
	for (const node of spec.nodes) {
		for (const [, value] of Object.entries(node.inputs || {})) {
			if (typeof value !== 'string') continue;
			// Check $inputs.X references
			const inputRefs = value.match(/\$inputs\.([\w-]+)/g);
			if (inputRefs) {
				for (const ref of inputRefs) {
					const name = ref.replace('$inputs.', '');
					if (!chainInputNames.has(name)) {
						throw new Error(`Node "${node.id}" references unknown chain input "$inputs.${name}"`);
					}
				}
			}
			// Check $nodes.X.output references
			const nodeRefs = value.match(/\$nodes\.([\w-]+)\.output/g);
			if (nodeRefs) {
				for (const ref of nodeRefs) {
					const match = ref.match(/\$nodes\.([\w-]+)\.output/);
					if (match && !nodeIds.has(match[1])) {
						throw new Error(`Node "${node.id}" references unknown node "$nodes.${match[1]}.output"`);
					}
				}
			}
		}
	}

	return spec;
}

/** Get execution levels — groups of nodes that can run in parallel */
export function getChainExecutionLevels(spec: ChainSpec): string[][] {
	const nodeMap = new Map(spec.nodes.map((n) => [n.id, n]));
	const levels: string[][] = [];
	const assigned = new Set<string>();

	while (assigned.size < spec.nodes.length) {
		const level: string[] = [];
		for (const node of spec.nodes) {
			if (assigned.has(node.id)) continue;
			const deps = node.depends_on || [];
			if (deps.every((d) => assigned.has(d))) {
				level.push(node.id);
			}
		}
		if (level.length === 0) {
			throw new Error('Unable to compute execution levels — possible unresolved dependency');
		}
		levels.push(level);
		for (const id of level) assigned.add(id);
	}

	return levels;
}

/** Validate a chain is ready to run — check required inputs */
export function validateChainRun(
	spec: ChainSpec,
	inputs: Record<string, string | number>,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const input of spec.inputs || []) {
		if (input.required === false) continue;
		const val = inputs[input.name] ?? input.default;
		if (val === undefined || val === '' || val === null) {
			errors.push(`Missing required input: ${input.name}${input.description ? ` (${input.description})` : ''}`);
		}
	}

	return { ok: errors.length === 0, errors };
}

/** Resolve $inputs.X and $nodes.X.output references in a string */
export function resolveChainRef(
	value: string,
	inputs: Record<string, string | number>,
	nodeOutputs: Record<string, string>,
): string {
	return value
		.replace(/\$inputs\.([\w-]+)/g, (_, name) => {
			const val = inputs[name];
			if (val === undefined) throw new Error(`Unknown chain input reference: $inputs.${name}`);
			return String(val);
		})
		.replace(/\$nodes\.([\w-]+)\.output\.([\w-]+)/g, (_, nodeId, stepId) => {
			const key = `${nodeId}:${stepId}`;
			const val = nodeOutputs[key];
			if (val !== undefined) return val;
			// Fallback: try the node-level output
			return nodeOutputs[nodeId] || '';
		})
		.replace(/\$nodes\.([\w-]+)\.output/g, (_, nodeId) => {
			const val = nodeOutputs[nodeId];
			if (val === undefined) throw new Error(`Unknown node output reference: $nodes.${nodeId}.output`);
			return val;
		});
}

/** Aggregate env vars from all referenced pipelines (deduped by name) */
export async function aggregateChainEnvVars(
	spec: ChainSpec,
	pipelinesDir: string,
): Promise<{ name: string; description: string; required: boolean; set: boolean }[]> {
	const envMap = new Map<string, { name: string; description: string; required: boolean; set: boolean }>();

	for (const node of spec.nodes) {
		try {
			const pipelineSpec = await parsePipeline(resolve(pipelinesDir, node.pipeline, 'pipeline.yaml'));
			for (const env of pipelineSpec.env || []) {
				if (!envMap.has(env.name)) {
					envMap.set(env.name, {
						name: env.name,
						description: env.description || '',
						required: env.required !== false,
						set: !!process.env[env.name],
					});
				}
			}
		} catch { /* skip unparseable pipelines */ }
	}

	return [...envMap.values()];
}
