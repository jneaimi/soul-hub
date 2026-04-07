<script lang="ts">
	import { onMount } from 'svelte';

	interface Project {
		name: string;
		devPath: string | null;
		brainPath: string | null;
		lastModified: string;
		type: string;
		hasGit: boolean;
	}

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let filter = $state('');
	let gitBranches = $state<Record<string, { branch: string; dirty: boolean }>>({});

	const typeColors: Record<string, string> = {
		development: 'bg-hub-cta/15 text-hub-cta',
		content: 'bg-hub-purple/15 text-hub-purple',
		research: 'bg-hub-info/15 text-hub-info',
		media: 'bg-hub-warning/15 text-hub-warning',
		operations: 'bg-hub-danger/15 text-hub-danger',
		unknown: 'bg-hub-dim/15 text-hub-dim',
	};

	const filtered = $derived(
		projects.filter((p) =>
			p.name.toLowerCase().includes(filter.toLowerCase())
		)
	);

	onMount(async () => {
		try {
			const res = await fetch('/api/projects');
			if (res.ok) {
				const data = await res.json();
				projects = data.projects;

				// Fetch git branches for projects with git repos (non-blocking)
				for (const p of data.projects) {
					if (p.hasGit && p.devPath) {
						fetch(`/api/git?path=${encodeURIComponent(p.devPath)}`)
							.then((r) => r.ok ? r.json() : null)
							.then((d) => {
								if (d?.isGit && d.branch) {
									gitBranches = { ...gitBranches, [p.name]: { branch: d.branch, dirty: d.dirty } };
								}
							})
							.catch(() => {});
					}
				}
			}
		} catch (e) {
			console.error('Failed to load projects', e);
		} finally {
			loading = false;
		}
	});

	function timeAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
</script>

<svelte:head>
	<title>Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-6 py-6 border-b border-hub-border">
		<div class="max-w-6xl mx-auto">
			<div class="flex items-center justify-between mb-6">
				<div>
					<h1 class="text-2xl font-bold text-hub-text">Soul Hub</h1>
					<p class="text-sm text-hub-muted mt-1">Project workspace</p>
				</div>
				<div class="flex items-center gap-2">
					<a
						href="/pipelines"
						class="p-2 rounded-lg text-hub-dim hover:text-hub-info hover:bg-hub-card transition-colors cursor-pointer"
						aria-label="Pipelines"
					>
						<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="5 3 19 12 5 21 5 3"/>
						</svg>
					</a>
					<a
						href="/library"
						class="p-2 rounded-lg text-hub-dim hover:text-hub-purple hover:bg-hub-card transition-colors cursor-pointer"
						aria-label="Library"
					>
						<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
						</svg>
					</a>
					<a
						href="/settings"
						class="p-2 rounded-lg text-hub-dim hover:text-hub-muted hover:bg-hub-card transition-colors cursor-pointer"
						aria-label="Settings"
					>
						<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
						</svg>
					</a>
					<a
						href="/new"
						class="px-4 py-2.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors"
					>
						New Project
					</a>
				</div>
			</div>

			<!-- Search -->
			<div class="relative">
				<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
				</svg>
				<input
					bind:value={filter}
					type="text"
					placeholder="Filter projects..."
					class="w-full bg-hub-card border border-hub-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
				/>
			</div>
		</div>
	</header>

	<!-- Project Grid -->
	<div class="flex-1 overflow-y-auto px-6 py-6">
		<div class="max-w-6xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading projects...</div>
				</div>
			{:else if filtered.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<svg class="w-12 h-12 text-hub-dim mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
					<p class="text-hub-muted text-sm">No projects found</p>
				</div>
			{:else}
				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{#each filtered as project}
						<a
							href="/project/{project.name}"
							class="group block bg-hub-card border border-hub-border rounded-xl p-4 hover:border-hub-cta/50 transition-all hover:shadow-lg hover:shadow-hub-cta/5"
						>
							<div class="flex items-start justify-between mb-3">
								<h3 class="font-semibold text-hub-text group-hover:text-hub-cta transition-colors truncate">
									{project.name}
								</h3>
								<span class="ml-2 flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-medium {typeColors[project.type] || typeColors.unknown}">
									{project.type}
								</span>
							</div>

							<div class="flex items-center gap-3 text-xs text-hub-dim">
								{#if project.devPath}
									<span class="flex items-center gap-1">
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
										code
									</span>
								{/if}
								{#if project.brainPath}
									<span class="flex items-center gap-1">
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
										brain
									</span>
								{/if}
								{#if gitBranches[project.name]}
									<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-hub-purple/10 text-hub-purple text-[10px] font-mono">
										{gitBranches[project.name].branch}
										{#if gitBranches[project.name].dirty}
											<span class="w-1 h-1 rounded-full bg-hub-warning"></span>
										{/if}
									</span>
								{:else if project.hasGit}
									<span class="flex items-center gap-1">
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
										git
									</span>
								{/if}
								<span class="ml-auto">{timeAgo(project.lastModified)}</span>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
