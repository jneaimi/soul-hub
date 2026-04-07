<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	// Template definitions (mirrored from server for UI)
	const templateDefs = [
		{
			id: 'development',
			name: 'Development',
			description: 'Full-stack web apps, APIs, CLI tools',
			icon: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
			color: 'hub-cta',
			variants: [
				{ id: 'sveltekit', label: 'SvelteKit' },
				{ id: 'nextjs', label: 'Next.js' },
				{ id: 'python', label: 'Python' },
				{ id: 'cli', label: 'CLI Tool' },
			],
			defaultSkills: ['deploy', 'test-coverage', 'code-review'],
			defaultAgents: ['security-reviewer', 'performance-reviewer'],
		},
		{
			id: 'content',
			name: 'Content',
			description: 'Writing, publishing, brand content',
			icon: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
			color: 'hub-purple',
			variants: null,
			defaultSkills: ['draft'],
			defaultAgents: ['arabic-writer', 'editor'],
		},
		{
			id: 'research',
			name: 'Research',
			description: 'Market research, trend analysis, reports',
			icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
			color: 'hub-info',
			variants: null,
			defaultSkills: ['collect'],
			defaultAgents: ['researcher'],
		},
		{
			id: 'media',
			name: 'Media',
			description: 'Images, video, voiceovers, design',
			icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
			color: 'hub-warning',
			variants: null,
			defaultSkills: ['generate'],
			defaultAgents: ['media-creator'],
		},
		{
			id: 'operations',
			name: 'Operations',
			description: 'DevOps, monitoring, infrastructure',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
			color: 'hub-danger',
			variants: null,
			defaultSkills: ['health-check', 'deploy'],
			defaultAgents: ['sentinel', 'watchtower'],
		},
		{
			id: 'custom',
			name: 'Custom',
			description: 'Blank slate — pick your own skills & agents',
			icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6',
			color: 'hub-dim',
			variants: null,
			defaultSkills: [],
			defaultAgents: [],
		},
	];

	interface CatalogSkill {
		name: string;
		description: string;
		category: string;
		runtime: string | null;
		userOnly: boolean;
		tags: string[];
	}

	interface CatalogAgent {
		name: string;
		description: string;
		category: string;
		model: string;
		effort: string;
		dependsOn: string[];
		tags: string[];
	}

	// State
	let selectedTemplate = $state<string | null>(null);
	let projectName = $state('');
	let selectedVariant = $state('sveltekit');
	let selectedSkills = $state<Set<string>>(new Set());
	let selectedAgents = $state<Set<string>>(new Set());
	let catalogSkills = $state<CatalogSkill[]>([]);
	let catalogAgents = $state<CatalogAgent[]>([]);
	let catalogTab = $state<'skills' | 'agents'>('skills');
	let catalogOpen = $state(false);
	let creating = $state(false);
	let error = $state('');
	let nameInput: HTMLInputElement;

	const colorMap: Record<string, string> = {
		'hub-cta': 'border-hub-cta/50 bg-hub-cta/10 text-hub-cta',
		'hub-purple': 'border-hub-purple/50 bg-hub-purple/10 text-hub-purple',
		'hub-info': 'border-hub-info/50 bg-hub-info/10 text-hub-info',
		'hub-warning': 'border-hub-warning/50 bg-hub-warning/10 text-hub-warning',
		'hub-danger': 'border-hub-danger/50 bg-hub-danger/10 text-hub-danger',
		'hub-dim': 'border-hub-dim/50 bg-hub-dim/10 text-hub-dim',
	};

	const colorMapSelected: Record<string, string> = {
		'hub-cta': 'border-hub-cta bg-hub-cta/20 text-hub-cta ring-2 ring-hub-cta/30',
		'hub-purple': 'border-hub-purple bg-hub-purple/20 text-hub-purple ring-2 ring-hub-purple/30',
		'hub-info': 'border-hub-info bg-hub-info/20 text-hub-info ring-2 ring-hub-info/30',
		'hub-warning': 'border-hub-warning bg-hub-warning/20 text-hub-warning ring-2 ring-hub-warning/30',
		'hub-danger': 'border-hub-danger bg-hub-danger/20 text-hub-danger ring-2 ring-hub-danger/30',
		'hub-dim': 'border-hub-dim bg-hub-dim/20 text-hub-dim ring-2 ring-hub-dim/30',
	};

	const runtimeBadge: Record<string, string> = {
		bash: 'bg-hub-cta/15 text-hub-cta',
		'python-uv': 'bg-hub-info/15 text-hub-info',
		python: 'bg-hub-info/15 text-hub-info',
		node: 'bg-hub-warning/15 text-hub-warning',
	};

	const modelBadge: Record<string, string> = {
		opus: 'bg-hub-purple/15 text-hub-purple',
		sonnet: 'bg-hub-info/15 text-hub-info',
		haiku: 'bg-hub-cta/15 text-hub-cta',
	};

	const currentTemplate = $derived(templateDefs.find((t) => t.id === selectedTemplate));

	const canCreate = $derived(
		selectedTemplate !== null && projectName.trim().length >= 2
	);

	// Load catalog data
	onMount(async () => {
		try {
			const res = await fetch('/api/catalog');
			if (res.ok) {
				const data = await res.json();
				catalogSkills = data.skills || [];
				catalogAgents = data.agents || [];
			}
		} catch (e) {
			console.error('Failed to load catalog', e);
		}
	});

	function selectTemplate(id: string) {
		selectedTemplate = id;
		error = '';

		// Apply default skills/agents for this template
		const tmpl = templateDefs.find((t) => t.id === id);
		if (tmpl) {
			selectedSkills = new Set(tmpl.defaultSkills);
			selectedAgents = new Set(tmpl.defaultAgents);
			if (tmpl.variants) {
				selectedVariant = tmpl.variants[0].id;
			}
		}

		// Focus name input after selection
		setTimeout(() => nameInput?.focus(), 100);
	}

	function toggleSkill(name: string) {
		const next = new Set(selectedSkills);
		if (next.has(name)) {
			next.delete(name);
		} else {
			next.add(name);
		}
		selectedSkills = next;
	}

	function toggleAgent(name: string) {
		const next = new Set(selectedAgents);
		if (next.has(name)) {
			next.delete(name);
		} else {
			next.add(name);
			// Auto-add dependent skills
			const agent = catalogAgents.find((a) => a.name === name);
			if (agent) {
				const skillsNext = new Set(selectedSkills);
				for (const dep of agent.dependsOn) {
					skillsNext.add(dep);
				}
				selectedSkills = skillsNext;
			}
		}
		selectedAgents = next;
	}

	async function createProject() {
		if (!canCreate || creating) return;
		creating = true;
		error = '';

		try {
			const res = await fetch('/api/create-project', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					templateId: selectedTemplate,
					name: projectName.trim(),
					variant: currentTemplate?.variants ? selectedVariant : undefined,
					skills: Array.from(selectedSkills),
					agents: Array.from(selectedAgents),
				}),
			});

			const data = await res.json();

			if (!res.ok) {
				error = data.error || 'Failed to create project';
				return;
			}

			// Redirect to the new project
			goto(`/project/${data.name}`);
		} catch (e) {
			error = 'Network error — is the server running?';
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>New Project — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-6 py-5 border-b border-hub-border">
		<div class="max-w-4xl mx-auto flex items-center gap-4">
			<a
				href="/"
				class="flex items-center gap-1.5 text-hub-dim hover:text-hub-text transition-colors text-sm"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="15 18 9 12 15 6"/>
				</svg>
				Back
			</a>
			<h1 class="text-xl font-bold text-hub-text">Create New Project</h1>
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-6 py-6">
		<div class="max-w-4xl mx-auto space-y-8">

			<!-- Step 1: Template Picker -->
			<section>
				<h2 class="text-sm font-semibold text-hub-muted uppercase tracking-wider mb-4">Choose a template</h2>
				<div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
					{#each templateDefs as tmpl}
						<button
							onclick={() => selectTemplate(tmpl.id)}
							class="text-left p-4 rounded-xl border transition-all {selectedTemplate === tmpl.id ? colorMapSelected[tmpl.color] : colorMap[tmpl.color]} hover:scale-[1.02]"
						>
							<div class="flex items-center gap-3 mb-2">
								<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
									<path d={tmpl.icon}/>
								</svg>
								<span class="font-semibold text-sm">{tmpl.name}</span>
							</div>
							<p class="text-xs text-hub-muted leading-relaxed">{tmpl.description}</p>
						</button>
					{/each}
				</div>
			</section>

			<!-- Step 2: Configuration (shown after template selection) -->
			{#if selectedTemplate}
				<section class="space-y-4">
					<h2 class="text-sm font-semibold text-hub-muted uppercase tracking-wider">Configure</h2>

					<!-- Project Name -->
					<div>
						<label for="project-name" class="block text-xs text-hub-dim mb-1.5">Project name</label>
						<input
							id="project-name"
							bind:this={nameInput}
							bind:value={projectName}
							type="text"
							placeholder="my-awesome-project"
							maxlength="64"
							class="w-full bg-hub-card border border-hub-border rounded-lg px-4 py-2.5 text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
							onkeydown={(e) => { if (e.key === 'Enter') createProject(); }}
						/>
						<p class="text-[10px] text-hub-dim mt-1">Lowercase letters, numbers, hyphens. Creates ~/dev/{projectName || '...'}/</p>
					</div>

					<!-- Variant (Development only) -->
					{#if currentTemplate?.variants}
						<div>
							<label for="variant" class="block text-xs text-hub-dim mb-1.5">Framework</label>
							<select
								id="variant"
								bind:value={selectedVariant}
								class="w-full bg-hub-card border border-hub-border rounded-lg px-4 py-2.5 text-sm text-hub-text focus:outline-none focus:border-hub-cta/50"
							>
								{#each currentTemplate.variants as v}
									<option value={v.id}>{v.label}</option>
								{/each}
							</select>
						</div>
					{/if}
				</section>

				<!-- Step 3: Catalog -->
				<section>
					<button
						onclick={() => { catalogOpen = !catalogOpen; }}
						class="flex items-center gap-2 text-sm font-semibold text-hub-muted uppercase tracking-wider hover:text-hub-text transition-colors"
					>
						<svg
							class="w-4 h-4 transition-transform {catalogOpen ? 'rotate-90' : ''}"
							viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						>
							<polyline points="9 18 15 12 9 6"/>
						</svg>
						Skills & Agents
						<span class="text-[10px] font-normal normal-case tracking-normal text-hub-dim">
							({selectedSkills.size} skills, {selectedAgents.size} agents selected)
						</span>
					</button>

					{#if catalogOpen}
						<div class="mt-4 space-y-4">
							<!-- Tabs -->
							<div class="flex gap-1 bg-hub-surface rounded-lg p-1">
								<button
									onclick={() => { catalogTab = 'skills'; }}
									class="flex-1 text-xs font-medium py-1.5 rounded-md transition-colors {catalogTab === 'skills' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
								>
									Skills ({catalogSkills.length})
								</button>
								<button
									onclick={() => { catalogTab = 'agents'; }}
									class="flex-1 text-xs font-medium py-1.5 rounded-md transition-colors {catalogTab === 'agents' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
								>
									Agents ({catalogAgents.length})
								</button>
							</div>

							<!-- Skills Tab -->
							{#if catalogTab === 'skills'}
								<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
									{#each catalogSkills as skill}
										<button
											onclick={() => toggleSkill(skill.name)}
											class="text-left p-3 rounded-lg border transition-all {selectedSkills.has(skill.name) ? 'border-hub-cta/60 bg-hub-cta/5' : 'border-hub-border bg-hub-card hover:border-hub-border'}"
										>
											<div class="flex items-center justify-between mb-1">
												<div class="flex items-center gap-2">
													<div class="w-4 h-4 rounded border flex items-center justify-center {selectedSkills.has(skill.name) ? 'bg-hub-cta border-hub-cta' : 'border-hub-dim'}">
														{#if selectedSkills.has(skill.name)}
															<svg class="w-3 h-3 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
														{/if}
													</div>
													<span class="text-sm font-medium text-hub-text">{skill.name}</span>
												</div>
												<div class="flex items-center gap-1.5">
													{#if skill.runtime}
														<span class="text-[9px] px-1.5 py-0.5 rounded font-medium {runtimeBadge[skill.runtime] || 'bg-hub-dim/15 text-hub-dim'}">
															{skill.runtime}
														</span>
													{/if}
													{#if skill.userOnly}
														<span class="text-[9px] px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple font-medium">
															user-only
														</span>
													{/if}
												</div>
											</div>
											<p class="text-[11px] text-hub-dim leading-relaxed ml-6">{skill.description}</p>
										</button>
									{/each}
								</div>
							{/if}

							<!-- Agents Tab -->
							{#if catalogTab === 'agents'}
								<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
									{#each catalogAgents as agent}
										<button
											onclick={() => toggleAgent(agent.name)}
											class="text-left p-3 rounded-lg border transition-all {selectedAgents.has(agent.name) ? 'border-hub-purple/60 bg-hub-purple/5' : 'border-hub-border bg-hub-card hover:border-hub-border'}"
										>
											<div class="flex items-center justify-between mb-1">
												<div class="flex items-center gap-2">
													<div class="w-4 h-4 rounded border flex items-center justify-center {selectedAgents.has(agent.name) ? 'bg-hub-purple border-hub-purple' : 'border-hub-dim'}">
														{#if selectedAgents.has(agent.name)}
															<svg class="w-3 h-3 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
														{/if}
													</div>
													<span class="text-sm font-medium text-hub-text">{agent.name}</span>
												</div>
												<div class="flex items-center gap-1.5">
													<span class="text-[9px] px-1.5 py-0.5 rounded font-medium {modelBadge[agent.model] || 'bg-hub-dim/15 text-hub-dim'}">
														{agent.model}
													</span>
													<span class="text-[9px] px-1.5 py-0.5 rounded bg-hub-dim/15 text-hub-dim font-medium">
														{agent.effort}
													</span>
												</div>
											</div>
											<p class="text-[11px] text-hub-dim leading-relaxed ml-6">{agent.description}</p>
											{#if agent.dependsOn.length > 0}
												<div class="mt-1.5 ml-6 flex items-center gap-1">
													<span class="text-[9px] text-hub-dim">needs:</span>
													{#each agent.dependsOn as dep}
														<span class="text-[9px] px-1.5 py-0.5 rounded bg-hub-surface text-hub-muted {selectedSkills.has(dep) ? '' : 'ring-1 ring-hub-warning/50'}">
															{dep}{#if !selectedSkills.has(dep)} ⚠{/if}
														</span>
													{/each}
												</div>
											{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</section>

				<!-- Error Message -->
				{#if error}
					<div class="p-3 rounded-lg bg-hub-danger/10 border border-hub-danger/30 text-hub-danger text-sm">
						{error}
					</div>
				{/if}

				<!-- Create Button -->
				<div class="pb-8">
					<button
						onclick={createProject}
						disabled={!canCreate || creating}
						class="w-full py-3 rounded-lg font-semibold text-sm transition-all
							{canCreate && !creating
								? 'bg-hub-cta text-black hover:bg-hub-cta-hover'
								: 'bg-hub-card text-hub-dim cursor-not-allowed'}"
					>
						{#if creating}
							<span class="flex items-center justify-center gap-2">
								<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
								Creating...
							</span>
						{:else}
							Create Project
						{/if}
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
