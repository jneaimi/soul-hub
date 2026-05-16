/** Task handler: trigger-pipeline.
 *
 *  Bridge from the new scheduler core to the existing pipeline runner.
 *  Settings declare:
 *
 *      {
 *        id: 'pipeline:signal-forge-daily',
 *        type: 'trigger-pipeline',
 *        cron: '0 6 * * *',
 *        params: { pipeline: 'signal-forge-daily' }
 *      }
 *
 *  At runtime, the factory resolves the pipeline name to its
 *  `pipeline.yaml` (or `chain.yaml`) path and invokes
 *  `executeScheduledRun` with `trigger: 'scheduled'` — same path the
 *  legacy pipeline cron used, so run history + step recording stay
 *  byte-identical to the pre-extraction behaviour.
 */

import { resolve, dirname } from 'node:path';
import { access } from 'node:fs/promises';
import { config } from '../../config.js';
import { executeScheduledRun } from '../../pipeline/index.js';
import type { TaskFn } from '../task-types.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

interface TriggerPipelineParams {
	pipeline: string;
}

function isParams(value: unknown): value is TriggerPipelineParams {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.pipeline === 'string' && v.pipeline.length > 0;
}

export function triggerPipelineFactory(params: unknown): TaskFn {
	if (!isParams(params)) {
		throw new Error(
			`trigger-pipeline: params must be { pipeline: string }, got ${JSON.stringify(params)}`,
		);
	}
	const pipelineName = params.pipeline;
	return async () => {
		// Resolve the YAML path lazily so a pipeline can be created/removed
		// without re-registering the task.
		const yamlPath = resolve(PIPELINES_DIR, pipelineName, 'pipeline.yaml');
		let actualPath = yamlPath;
		try {
			await access(yamlPath);
		} catch {
			// Fall back to chain.yaml; if neither exists, executeScheduledRun
			// will short-circuit with a warning.
			actualPath = resolve(PIPELINES_DIR, pipelineName, 'chain.yaml');
		}
		const result = await executeScheduledRun(pipelineName, actualPath, 'scheduled');
		return { runId: result.runId, status: result.status, pipeline: pipelineName };
	};
}
