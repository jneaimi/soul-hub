/** Pipeline YAML spec types */

export interface PipelineInput {
	name: string;
	type: 'text' | 'file' | 'path' | 'select' | 'number';
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
	type: 'script' | 'agent' | 'approval' | 'prompt';
	/** For type: script — command to run */
	run?: string;
	/** For type: agent — agent name from marketplace/agents/ */
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
	/** Condition: only run this step when expression is true */
	when?: string;
	/** Condition: skip this step when expression is true (inverse of when) */
	skip_if?: string;
}

export interface PipelineOnFailure {
	notify?: boolean;
	strategy?: 'halt' | 'skip' | 'retry';
}

export interface PipelineSpec {
	name: string;
	description: string;
	version?: string;
	author?: string;
	inputs?: PipelineInput[];
	env?: PipelineEnvVar[];
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
