/** Pipeline YAML spec types */

export interface PipelineInput {
	name: string;
	type: 'text' | 'file' | 'path' | 'folder' | 'select' | 'number';
	description: string;
	default?: string | number;
	options?: string[]; // for type: select
	required?: boolean;
}

export interface PipelineEnvVar {
	name: string;
	description: string;
	required?: boolean;
}

export interface PipelineStep {
	id: string;
	type: 'script' | 'agent' | 'approval' | 'prompt' | 'channel' | 'chunk' | 'loop';
	/** Block reference — name of a block in <pipeline-dir>/blocks/ */
	block?: string;
	/** Config overrides for the referenced block (merged with block defaults) */
	config?: Record<string, unknown>;
	/** For type: script — command to run */
	run?: string;
	/** For type: agent — agent name from catalog/agents/ */
	agent?: string;
	/** Skills to pre-load for agent steps */
	skills?: string[];
	/** Prompt for agent steps */
	prompt?: string;
	/** Input — file path or $steps.X.output or $inputs.Y reference */
	input?: string | string[];
	/** Output — file path where this step writes its result (not required for approval/prompt/action/webhook types) */
	output?: string;
	/** Output type — determines how the output is tracked and displayed */
	output_type?: 'file' | 'media' | 'action' | 'response' | 'webhook';
	/** Steps that must complete before this one */
	depends_on?: string[];
	/** Timeout in seconds (default: 300) */
	timeout?: number;
	/** Number of retries on failure (default: 0) */
	retry?: number;
	/** For type: approval — message shown to user */
	message?: string;
	/** For type: approval — file to render for review */
	show?: string;
	/** For type: prompt — question to ask the user */
	question?: string;
	/** For type: prompt — dynamic options from previous step output */
	options_from?: string;
	/** For type: prompt — static options */
	options?: string[];
	/** For type: channel — channel adapter id (omit for default) */
	channel?: string;
	/** For type: channel — action to perform */
	action?: 'send';
	/** For type: channel — file to attach */
	attach?: string;
	/** For type: chunk — max concurrent chunk executions (default: 1, max: 5 for agents) */
	parallel?: number;
	/** For type: chunk — how to merge chunk outputs: concat | json-array | skip (default: skip) */
	merge?: 'concat' | 'json-array' | 'skip';
	/** For type: chunk — path for merged output (required if merge != skip) */
	merge_output?: string;
	/** For type: chunk — max number of chunks to process (default: 500) */
	max_chunks?: number;
	/** For type: chunk — what to do when a chunk fails: halt | skip (default: halt) */
	chunk_on_failure?: 'halt' | 'skip';
	/** For type: loop — max iterations (default: 3, max: 10) */
	max_iterations?: number;
	/** For type: loop — condition to stop looping (must reference own step output) */
	until?: string;
	/** Total timeout for entire chunk/loop step in seconds (default: 1800 for chunk, 900 for loop) */
	total_timeout?: number;
	/** Condition: only run this step when expression is true */
	when?: string;
	/** Condition: skip this step when expression is true (inverse of when) */
	skip_if?: string;
}

export interface PipelineOnFailure {
	notify?: boolean;
	strategy?: 'halt' | 'skip' | 'retry';
}

/** MCP server declaration — makes server available to agent steps */
export interface PipelineMcp {
	/** Server name (must match a key in project or global .mcp.json) */
	name: string;
	/** Optional: inline server config (overrides .mcp.json lookup) */
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
}

export interface ConfigColumn {
	name: string;
	type: 'text' | 'select' | 'number';
	label: string;
	placeholder?: string;
	options?: string[];
	required?: boolean;
}

export interface PipelineConfigFile {
	name: string;
	file: string;
	description?: string;
	columns?: ConfigColumn[];
}

export interface PipelineSpec {
	name: string;
	description: string;
	version?: string;
	author?: string;
	inputs?: PipelineInput[];
	env?: PipelineEnvVar[];
	mcp?: PipelineMcp[];
	shared_config?: PipelineConfigFile[];
	steps: PipelineStep[];
	on_failure?: PipelineOnFailure;
}

/** Runtime step status */
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting';

export interface StepResult {
	id: string;
	status: StepStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	exitCode?: number;
	error?: string;
	outputPath?: string;
	outputType?: 'file' | 'media' | 'action' | 'response' | 'webhook';
	attempt: number;
}

export interface PipelineRun {
	runId: string;
	pipelineName: string;
	status: 'pending' | 'running' | 'done' | 'failed';
	startedAt: string;
	finishedAt?: string;
	steps: StepResult[];
	resolvedInputs: Record<string, string | number>;
}
