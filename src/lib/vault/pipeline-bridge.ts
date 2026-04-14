import { getVaultEngine } from './index.js';
import { readFile } from 'node:fs/promises';

interface PipelineRunContext {
	pipelineName: string;
	runId: string;
	status: 'done' | 'failed';
	startedAt: string;
	finishedAt: string;
	steps: {
		id: string;
		status: string;
		durationMs?: number;
		error?: string;
		outputPath?: string;
	}[];
	resolvedInputs: Record<string, string | number>;
}

interface PipelineOutputContext {
	pipelineName: string;
	runId: string;
	stepId: string;
	stepType: string;
	outputPath: string;
	outputType?: string;
}

/**
 * Save a pipeline step output as a vault note.
 * Non-blocking — failures are logged but don't break the pipeline.
 */
export async function savePipelineOutput(ctx: PipelineOutputContext): Promise<string | undefined> {
	const engine = getVaultEngine();
	if (!engine) {
		console.warn('[vault/pipeline] Engine not initialized — skipping output save');
		return;
	}

	try {
		const rawContent = await readFile(ctx.outputPath, 'utf-8');

		const zone = `projects/${ctx.pipelineName}/outputs`;

		const today = new Date().toISOString().slice(0, 10);
		const shortRunId = ctx.runId.slice(0, 8);
		const filename = `${today}-${ctx.stepId}-${shortRunId}.md`;

		const isJson = ctx.outputPath.endsWith('.json');
		const isMarkdown = ctx.outputPath.endsWith('.md');

		let content: string;
		if (isMarkdown) {
			content = rawContent;
		} else if (isJson) {
			content = `## Output\n\n\`\`\`json\n${rawContent}\n\`\`\``;
		} else {
			content = `## Output\n\n\`\`\`\n${rawContent}\n\`\`\``;
		}

		if (!isMarkdown) {
			content = `# Pipeline Output: ${ctx.stepId}\n\nPart of [[projects/${ctx.pipelineName}/index|${ctx.pipelineName}]]\n\n## Pipeline Context\n\n- **Pipeline**: ${ctx.pipelineName}\n- **Run ID**: ${ctx.runId}\n- **Step**: ${ctx.stepId} (${ctx.stepType})\n- **Date**: ${today}\n\n${content}`;
		}

		const result = await engine.createNote({
			zone,
			filename,
			meta: {
				type: 'output',
				created: today,
				tags: ['pipeline', ctx.pipelineName, ctx.stepId],
				project: ctx.pipelineName,
				pipeline: ctx.pipelineName,
				run_id: ctx.runId,
				step: ctx.stepId,
			},
			content,
		});

		if (result.success) {
			console.log(`[vault/pipeline] Saved output: ${result.path}`);
			return result.path;
		} else {
			console.log(`[vault/pipeline] Skipped: ${result.error}`);
		}
	} catch (err) {
		console.error(`[vault/pipeline] Failed to save output:`, err instanceof Error ? err.message : err);
	}
	return undefined;
}

/**
 * Save a pipeline run summary as a vault note.
 * Called when a pipeline completes (success or failure).
 * Non-blocking — failures are logged but don't affect the pipeline.
 */
export async function savePipelineRunSummary(ctx: PipelineRunContext): Promise<void> {
	const engine = getVaultEngine();
	if (!engine) {
		console.warn('[vault/pipeline] Engine not initialized — skipping run summary save');
		return;
	}

	try {
		const zone = `projects/${ctx.pipelineName}/outputs`;
		const date = ctx.startedAt.slice(0, 10);
		const shortId = ctx.runId.slice(0, 8);
		const filename = `${date}-run-${shortId}.md`;

		const startMs = new Date(ctx.startedAt).getTime();
		const endMs = new Date(ctx.finishedAt).getTime();
		const durationSec = Math.floor((endMs - startMs) / 1000);
		const durationStr = durationSec < 60 ? `${durationSec}s` :
			`${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

		const stepCounts = { done: 0, failed: 0, skipped: 0, other: 0 };
		for (const step of ctx.steps) {
			if (step.status === 'done') stepCounts.done++;
			else if (step.status === 'failed') stepCounts.failed++;
			else if (step.status === 'skipped') stepCounts.skipped++;
			else stepCounts.other++;
		}

		let content = `# Pipeline Run: ${ctx.pipelineName}\n\nPart of [[projects/${ctx.pipelineName}/index|${ctx.pipelineName}]]\n\n`;
		content += `## Summary\n\n`;
		content += `- **Status**: ${ctx.status === 'done' ? 'Success' : 'Failed'}\n`;
		content += `- **Run ID**: \`${ctx.runId}\`\n`;
		content += `- **Duration**: ${durationStr}\n`;
		content += `- **Steps**: ${stepCounts.done} done, ${stepCounts.failed} failed, ${stepCounts.skipped} skipped\n`;
		content += `- **Date**: ${date}\n\n`;

		if (Object.keys(ctx.resolvedInputs).length > 0) {
			content += `## Inputs\n\n`;
			for (const [key, value] of Object.entries(ctx.resolvedInputs)) {
				content += `- **${key}**: ${value}\n`;
			}
			content += `\n`;
		}

		content += `## Steps\n\n`;
		content += `| Step | Status | Duration | Output |\n`;
		content += `|------|--------|----------|--------|\n`;
		for (const step of ctx.steps) {
			const dur = step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : '-';
			const out = step.outputPath ? `\`${step.outputPath.split('/').pop()}\`` : '-';
			const statusEmoji = step.status === 'done' ? 'done' : step.status === 'failed' ? 'FAILED' : step.status;
			content += `| ${step.id} | ${statusEmoji} | ${dur} | ${out} |\n`;
		}
		content += `\n`;

		const failedSteps = ctx.steps.filter(s => s.error);
		if (failedSteps.length > 0) {
			content += `## Errors\n\n`;
			for (const step of failedSteps) {
				content += `### ${step.id}\n\n`;
				content += `\`\`\`\n${step.error}\n\`\`\`\n\n`;
			}
		}

		const tags = ['pipeline', 'run-summary', ctx.pipelineName];
		if (ctx.status === 'failed') tags.push('failed');

		const result = await engine.createNote({
			zone,
			filename,
			meta: {
				type: 'output',
				created: date,
				tags,
				project: ctx.pipelineName,
				pipeline: ctx.pipelineName,
				run_id: ctx.runId,
				status: ctx.status,
				duration_sec: durationSec,
			},
			content,
		});

		if (result.success) {
			console.log(`[vault/pipeline] Run summary saved: ${result.path}`);
		} else {
			console.log(`[vault/pipeline] Run summary skipped: ${result.error}`);
		}
	} catch (err) {
		console.error(`[vault/pipeline] Run summary failed:`, err instanceof Error ? err.message : err);
	}
}
