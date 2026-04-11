<script lang="ts">
	import { onMount } from 'svelte';
	import { type Project, type Suggestion, type GitBranchInfo, fetchProjects, fetchGitBranches, addProjectApi, removeProjectApi, timeAgo } from '$lib/data/projects.js';

	let projects = $state<Project[]>([]);
	let suggestions = $state<Suggestion[]>([]);
	let loading = $state(true);
	let error = $state('');
	let filter = $state('');
	let gitBranches = $state<Record<string, GitBranchInfo>>({});

	let showAddModal = $state(false);
	let addingPaths = $state<Set<string>>(new Set());
	let removeMenuOpen = $state<string | null>(null);

	const typeColorMap: Record<string, string> = {
		'web-app': 'bg-hub-cta/15 text-hub-cta',
		pipeline: 'bg-hub-purple/15 text-hub-purple',
		research: 'bg-hub-info/15 text-hub-info',
		library: 'bg-hub-warning/15 text-hub-warning',
		api: 'bg-hub-danger/15 text-hub-danger',
		unknown: 'bg-hub-dim/15 text-hub-dim',
	};

	const filtered = $derived(
		projects.filter((p) =>
			p.name.toLowerCase().includes(filter.toLowerCase())
		)
	);

	async function loadProjects() {
		error = '';
		try {
			const data = await fetchProjects();
			projects = data.projects;
			suggestions = data.suggestions;
			gitBranches = await fetchGitBranches(data.projects);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	onMount(() => { loadProjects(); });

	async function addProject(path: string) {
		addingPaths = new Set([...addingPaths, path]);
		try {
			await addProjectApi(path);
			await loadProjects();
		} catch {
			error = 'Failed to add project';
		} finally {
			const next = new Set(addingPaths);
			next.delete(path);
			addingPaths = next;
		}
	}

	async function addAllSuggestions() {
		for (const s of suggestions) {
			await addProject(s.path);
		}
		showAddModal = false;
	}

	async function removeProject(path: string) {
		removeMenuOpen = null;
		try {
			await removeProjectApi(path);
			await loadProjects();
		} catch {
			error = 'Failed to remove project';
		}
	}

	function handleClickOutside() {
		if (removeMenuOpen) removeMenuOpen = null;
	}
</script>

<svelte:head>
	<title>Projects | Soul Hub</title>
</svelte:head>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="h-full flex flex-col" onclick={handleClickOutside}>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-3xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to home">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
					</svg>
				</a>
				<div class="flex items-center gap-2">
					<img src="/logo.png" alt="Soul Hub" class="w-5 h-5" />
					<h1 class="text-lg font-semibold text-hub-text">Projects</h1>
					{#if projects.length > 0}
						<span class="text-hub-dim font-normal text-sm ml-1">({projects.length})</span>
					{/if}
				</div>
			</div>
			<div class="flex items-center gap-2">
				{#if suggestions.length > 0}
					<button
						onclick={() => { showAddModal = true; }}
						class="hidden sm:inline-flex px-3 py-1.5 rounded-lg border border-hub-border text-hub-muted text-sm hover:text-hub-text hover:border-hub-dim transition-colors cursor-pointer"
					>
						Add Existing
					</button>
				{/if}
				<a
					href="/new"
					class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors cursor-pointer"
				>
					+ New
				</a>
			</div>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">
		<div class="max-w-3xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading...</div>
				</div>
			{:else}
				{#if error}
					<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-6 flex items-center justify-between">
						<span>{error}</span>
						<button onclick={() => { error = ''; loadProjects(); }} class="text-xs underline cursor-pointer">Retry</button>
					</div>
				{/if}

				<!-- Empty state -->
				{#if projects.length === 0 && suggestions.length === 0}
					<div class="flex flex-col items-center justify-center py-20">
						<p class="text-hub-muted text-sm mb-3">No projects yet</p>
						<a href="/new" class="text-sm text-hub-cta hover:text-hub-cta-hover transition-colors cursor-pointer">Create your first project</a>
					</div>
				{:else if projects.length === 0 && suggestions.length > 0}
					<!-- First-time: only suggestions -->
					<div class="border border-hub-cta/30 rounded-xl p-6 mb-8">
						<div class="flex items-start justify-between mb-4">
							<div>
								<h2 class="text-base font-semibold text-hub-text">
									{suggestions.length} project{suggestions.length === 1 ? '' : 's'} found in ~/dev/
								</h2>
								<p class="text-sm text-hub-muted mt-1">Add them to start managing from Soul Hub.</p>
							</div>
							<button
								onclick={addAllSuggestions}
								class="px-4 py-2 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors cursor-pointer flex-shrink-0"
							>
								Add All
							</button>
						</div>
						<div class="space-y-2">
							{#each suggestions as suggestion}
								<div class="flex items-center justify-between py-2 px-3 rounded-lg bg-hub-surface/50">
									<div class="flex items-center gap-2 min-w-0">
										<span class="text-sm font-medium text-hub-text truncate">{suggestion.name}</span>
										{#if suggestion.hasGit}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-purple/15 text-hub-purple">git</span>
										{/if}
									</div>
									<button
										onclick={() => addProject(suggestion.path)}
										disabled={addingPaths.has(suggestion.path)}
										class="px-3 py-1 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
									>
										{addingPaths.has(suggestion.path) ? 'Adding...' : 'Add'}
									</button>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Project list -->
				{#if projects.length > 0}
					<!-- Filter -->
					{#if projects.length > 5}
						<div class="relative mb-3">
							<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
							</svg>
							<input
								bind:value={filter}
								type="text"
								placeholder="Filter..."
								class="w-full bg-transparent border border-hub-border rounded-lg pl-9 pr-3 py-2 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
							/>
						</div>
					{/if}

					{#if filtered.length === 0}
						<p class="text-hub-dim text-xs py-6 text-center">No projects match "{filter}"</p>
					{:else}
						<div class="divide-y divide-hub-border/60">
							{#each filtered as project}
								<div class="group relative">
									<a
										href="/project/{project.name}"
										class="flex items-center gap-3 py-3 sm:py-3.5 hover:bg-hub-card/30 -mx-2 px-2 rounded-lg transition-colors cursor-pointer"
									>
										<!-- Desktop: single row -->
										<div class="hidden sm:flex items-center gap-3 flex-1 min-w-0">
											<span class="font-medium text-sm text-hub-text group-hover:text-hub-cta transition-colors truncate">
												{project.name}
											</span>
											<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider {typeColorMap[project.type] || typeColorMap.unknown}">
												{project.type}
											</span>
											{#if gitBranches[project.name]}
												<span class="flex-shrink-0 text-[11px] font-mono text-hub-purple">
													{gitBranches[project.name].branch}
													{#if gitBranches[project.name].dirty}
														<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning ml-1 -mb-px"></span>
													{/if}
												</span>
											{/if}
											{#if project.description}
												<span class="text-xs text-hub-dim truncate flex-1">{project.description}</span>
											{/if}
											<span class="ml-auto flex-shrink-0 text-[11px] text-hub-dim">{timeAgo(project.lastModified)}</span>
										</div>

										<!-- Mobile: two lines -->
										<div class="flex sm:hidden flex-col gap-1 flex-1 min-w-0">
											<span class="font-medium text-sm text-hub-text group-hover:text-hub-cta transition-colors truncate">
												{project.name}
											</span>
											<div class="flex items-center gap-2 text-[11px]">
												<span class="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider {typeColorMap[project.type] || typeColorMap.unknown}">
													{project.type}
												</span>
												{#if gitBranches[project.name]}
													<span class="font-mono text-hub-purple truncate">
														{gitBranches[project.name].branch}
														{#if gitBranches[project.name].dirty}
															<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning ml-0.5 -mb-px"></span>
														{/if}
													</span>
												{/if}
												<span class="ml-auto text-hub-dim flex-shrink-0">{timeAgo(project.lastModified)}</span>
											</div>
										</div>
									</a>

									<!-- Remove button (desktop hover) -->
									{#if project.devPath}
										<div class="absolute top-1/2 -translate-y-1/2 right-0 hidden sm:block">
											<button
												onclick={(e) => { e.preventDefault(); e.stopPropagation(); removeMenuOpen = removeMenuOpen === project.name ? null : project.name; }}
												class="p-1.5 rounded-md text-hub-dim opacity-0 group-hover:opacity-100 hover:text-hub-muted hover:bg-hub-card transition-all cursor-pointer"
												aria-label="Options"
											>
												<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
												</svg>
											</button>
											{#if removeMenuOpen === project.name}
												<div class="absolute right-0 top-8 z-10 bg-hub-surface border border-hub-border rounded-lg shadow-xl py-1 min-w-[120px]">
													<button
														onclick={(e) => { e.preventDefault(); e.stopPropagation(); removeProject(project.devPath!); }}
														class="w-full text-left px-3 py-1.5 text-xs text-hub-danger hover:bg-hub-danger/10 transition-colors cursor-pointer flex items-center gap-2"
													>
														<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
														Remove
													</button>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					<!-- Suggestions hint -->
					{#if suggestions.length > 0}
						<div class="mt-6 flex items-center justify-center">
							<button
								onclick={() => { showAddModal = true; }}
								class="text-xs text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
							>
								{suggestions.length} unmanaged project{suggestions.length === 1 ? '' : 's'} found &middot; Add
							</button>
						</div>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
</div>

<!-- Add Existing Project Modal -->
{#if showAddModal}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
		onclick={() => { showAddModal = false; }}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="bg-hub-surface border border-hub-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="flex items-center justify-between px-5 py-4 border-b border-hub-border">
				<h2 class="text-base font-semibold text-hub-text">Add Existing Project</h2>
				<button
					onclick={() => { showAddModal = false; }}
					class="p-1 rounded-md text-hub-dim hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
					aria-label="Close"
				>
					<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M18 6L6 18"/><path d="M6 6l12 12"/>
					</svg>
				</button>
			</div>
			<div class="flex-1 overflow-y-auto px-5 py-4">
				{#if suggestions.length === 0}
					<div class="text-center py-8">
						<p class="text-hub-muted text-sm">All projects in ~/dev/ are already managed</p>
					</div>
				{:else}
					<div class="flex items-center justify-between mb-3">
						<p class="text-sm text-hub-muted">{suggestions.length} unmanaged project{suggestions.length === 1 ? '' : 's'}</p>
						<button
							onclick={addAllSuggestions}
							class="px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-cta text-black hover:bg-hub-cta-hover transition-colors cursor-pointer"
						>
							Add All
						</button>
					</div>
					<div class="space-y-2">
						{#each suggestions as suggestion}
							<div class="flex items-center justify-between bg-hub-card border border-hub-border rounded-lg p-3 hover:border-hub-cta/30 transition-colors">
								<div class="flex items-center gap-2 min-w-0">
									<span class="text-sm font-medium text-hub-text truncate">{suggestion.name}</span>
									{#if suggestion.hasGit}
										<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-purple/15 text-hub-purple">git</span>
									{/if}
									{#if suggestion.hasClaude}
										<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-info/15 text-hub-info">claude</span>
									{/if}
								</div>
								<button
									onclick={() => addProject(suggestion.path)}
									disabled={addingPaths.has(suggestion.path)}
									class="ml-3 px-3 py-1.5 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
								>
									{addingPaths.has(suggestion.path) ? 'Adding...' : 'Add'}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
