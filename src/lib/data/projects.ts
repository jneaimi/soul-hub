/** Shared project types and data-loading functions */

export interface Project {
	name: string;
	devPath: string | null;
	lastModified: string;
	type: string;
	hasGit: boolean;
	description: string;
}

export interface Suggestion {
	name: string;
	path: string;
	hasGit: boolean;
	hasClaude: boolean;
}

export interface GitBranchInfo {
	branch: string;
	dirty: boolean;
}

/** Load projects and suggestions from API */
export async function fetchProjects(): Promise<{ projects: Project[]; suggestions: Suggestion[] }> {
	const res = await fetch('/api/projects');
	if (!res.ok) throw new Error(`Failed to load projects: ${res.status}`);
	const data = await res.json();
	return { projects: data.projects, suggestions: data.suggestions || [] };
}

/** Fetch git branch info for projects with git repos, max 5 concurrent */
export async function fetchGitBranches(projects: Project[]): Promise<Record<string, GitBranchInfo>> {
	const gitProjects = projects.filter(p => p.hasGit && p.devPath);
	const branches: Record<string, GitBranchInfo> = {};

	// Batch in groups of 5 to limit concurrency
	for (let i = 0; i < gitProjects.length; i += 5) {
		const batch = gitProjects.slice(i, i + 5);
		const results = await Promise.allSettled(
			batch.map(async (p) => {
				const res = await fetch(`/api/git?path=${encodeURIComponent(p.devPath!)}`);
				if (!res.ok) return null;
				const d = await res.json();
				if (d?.isGit && d.branch) {
					return { name: p.name, branch: d.branch, dirty: d.dirty };
				}
				return null;
			})
		);
		for (const result of results) {
			if (result.status === 'fulfilled' && result.value) {
				branches[result.value.name] = { branch: result.value.branch, dirty: result.value.dirty };
			}
		}
	}
	return branches;
}

/** Register a folder as a managed project */
export async function addProjectApi(path: string): Promise<boolean> {
	const res = await fetch('/api/projects', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path }),
	});
	return res.ok;
}

/** Unregister a managed project */
export async function removeProjectApi(path: string): Promise<boolean> {
	const res = await fetch('/api/projects', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path }),
	});
	return res.ok;
}

/** Format an ISO timestamp as relative time */
export function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Project type → Tailwind color classes */
export const typeColors: Record<string, string> = {
	'web-app': 'bg-hub-cta/15 text-hub-cta',
	'api': 'bg-hub-info/15 text-hub-info',
	'cli': 'bg-hub-purple/15 text-hub-purple',
	'library': 'bg-hub-warning/15 text-hub-warning',
	'mobile': 'bg-hub-info/15 text-hub-info',
	'script': 'bg-hub-dim/15 text-hub-dim',
	'automation': 'bg-hub-cta/15 text-hub-cta',
	unknown: 'bg-hub-dim/15 text-hub-dim',
};
