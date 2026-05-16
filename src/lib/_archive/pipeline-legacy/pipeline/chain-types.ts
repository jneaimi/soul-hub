import type { PipelineInput, PipelineRun, StepStatus } from './types.js';

export interface ChainNode {
	id: string;
	/** Name of pipeline directory in pipelines/ */
	pipeline: string;
	/** Map chain inputs/node outputs to pipeline inputs */
	inputs?: Record<string, string | number>;
	/** Steps that must complete before this node */
	depends_on?: string[];
	/** Timeout in seconds for the entire pipeline run (default: 600) */
	timeout?: number;
	/** Retry count (default: 0) */
	retry?: number;
	/** Condition: only run when expression is true */
	when?: string;
	/** Condition: skip when expression is true */
	skip_if?: string;
}

export interface ChainSpec {
	name: string;
	description: string;
	version?: string;
	author?: string;
	type: 'chain';
	inputs?: PipelineInput[];
	nodes: ChainNode[];
	on_failure?: {
		strategy?: 'halt' | 'halt-branch' | 'skip-dependents';
	};
}

export type ChainNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting';

export interface ChainNodeRun {
	id: string;
	pipelineName: string;
	status: ChainNodeStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	error?: string;
	/** The inner pipeline run (full step-level detail) */
	pipelineRun?: PipelineRun;
	/** Output path from the last completed step (for handoff to downstream nodes) */
	outputPath?: string;
	attempt: number;
}

export interface ChainRun {
	runId: string;
	chainName: string;
	type: 'chain';
	status: 'pending' | 'running' | 'done' | 'failed';
	startedAt: string;
	finishedAt?: string;
	nodes: ChainNodeRun[];
	resolvedInputs: Record<string, string | number>;
}
