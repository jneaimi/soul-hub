import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { config } from '$lib/config.js';
import { listPipelines, getRunHistory } from '$lib/pipeline/index.js';

interface ActivityItem {
	type: 'pipeline_run' | 'project_change';
	name: string;
	status: 'done' | 'failed' | 'running';
	timestamp: string;
	detail?: string;
}

interface ProjectInfo {
	name: string;
	type?: string;
	mtime: number;
}

async function getProjects(): Promise<ProjectInfo[]> {
	const devDir = config.resolved.devDir;
	const projects: ProjectInfo[] = [];

	try {
		const entries = await readdir(devDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const metaPath = join(devDir, entry.name, '.soul-hub.json');
			try {
				const metaStat = await stat(metaPath);
				const raw = await readFile(metaPath, 'utf-8');
				const meta = JSON.parse(raw);
				projects.push({
					name: meta.name || entry.name,
					type: meta.type,
					mtime: metaStat.mtimeMs
				});
			} catch {
				// No .soul-hub.json — skip
			}
		}
	} catch {
		// devDir unreadable
	}

	projects.sort((a, b) => b.mtime - a.mtime);
	return projects;
}

function getPipelineActivity(): ActivityItem[] {
	const history = getRunHistory(10);
	return history.map(h => ({
		type: 'pipeline_run' as const,
		name: h.pipelineName,
		status: h.status === 'done' ? 'done' as const : 'failed' as const,
		timestamp: h.startedAt,
	}));
}

export const GET: RequestHandler = async () => {
	const pipelinesDir = resolve(dirname(config.resolved.catalogDir), 'pipelines');
	const [pipelines, projects] = await Promise.all([
		listPipelines(pipelinesDir),
		getProjects(),
	]);
	const pipelineActivity = getPipelineActivity();

	const pipelineSummary = {
		total: pipelines.length,
		names: pipelines.map((p) => p.name),
		items: pipelines.map((p) => ({ name: p.name, type: p.type }))
	};

	const projectSummary = {
		total: projects.length,
		recentNames: projects.slice(0, 3).map((p) => p.name)
	};

	const projectActivity: ActivityItem[] = projects.slice(0, 5).map((p) => ({
		type: 'project_change' as const,
		name: p.name,
		status: 'done' as const,
		timestamp: new Date(p.mtime).toISOString(),
		detail: p.type
	}));

	const recentActivity = [...projectActivity, ...pipelineActivity]
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
		.slice(0, 10);

	return json({ recentActivity, pipelineSummary, projectSummary }, { status: 200 });
};
