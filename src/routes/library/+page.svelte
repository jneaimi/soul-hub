<script lang="ts">
	import { onMount } from 'svelte';

	interface EnvVar {
		name: string;
		description: string;
		required: boolean;
		set: boolean;
	}

	interface LibraryItem {
		name: string;
		type: 'skill' | 'agent' | 'pipeline' | 'mcp' | 'script';
		source: 'yours' | 'catalog';
		description: string;
		category?: string;
		env_vars?: EnvVar[];
		runtime?: string | null;
		model?: string;
		effort?: string;
		dependsOn?: string[];
		tags?: string[];
		path: string;
		mcpCommand?: string;
		mcpArgs?: string[];
		mcpUrl?: string;
		mcpType?: 'stdio' | 'http';
		mcpProject?: string;
	}

	let items = $state<LibraryItem[]>([]);
	let loading = $state(true);

	// Filters
	let typeFilter = $state<'all' | 'skill' | 'agent' | 'pipeline' | 'mcp' | 'script'>('all');
	let sourceFilter = $state<'all' | 'yours' | 'catalog'>('all');
	let search = $state('');

	// Preview
	let selected = $state<LibraryItem | null>(null);
	let previewContent = $state<string | null>(null);
	let loadingPreview = $state(false);

	let filtered = $derived.by(() => {
		let result = items;
		if (typeFilter !== 'all') result = result.filter((i) => i.type === typeFilter);
		if (sourceFilter !== 'all') result = result.filter((i) => i.source === sourceFilter);
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter((i) =>
				i.name.toLowerCase().includes(q) ||
				i.description.toLowerCase().includes(q) ||
				(i.tags || []).some((t) => t.toLowerCase().includes(q))
			);
		}
		return result;
	});

	let counts = $derived({
		all: items.length,
		script: items.filter((i) => i.type === 'script').length,
		skill: items.filter((i) => i.type === 'skill').length,
		agent: items.filter((i) => i.type === 'agent').length,
		pipeline: items.filter((i) => i.type === 'pipeline').length,
		mcp: items.filter((i) => i.type === 'mcp').length,
		yours: items.filter((i) => i.source === 'yours').length,
		catalog: items.filter((i) => i.source === 'catalog').length,
	});

	onMount(async () => {
		try {
			const res = await fetch('/api/library');
			if (res.ok) items = await res.json();
		} catch { /* ignore */ }
		loading = false;
	});

	async function selectItem(item: LibraryItem) {
		selected = item;
		previewContent = null;
		loadingPreview = true;

		// Load file content for preview
		try {
			if (item.type === 'mcp') {
				// For MCP items, show the server config as formatted JSON
				const cfg: Record<string, any> = {};
				if (item.mcpCommand) cfg.command = item.mcpCommand;
				if (item.mcpArgs) cfg.args = item.mcpArgs;
				if (item.mcpUrl) cfg.url = item.mcpUrl;
				if (item.mcpType === 'http') cfg.type = 'http';
				if (item.env_vars && item.env_vars.length > 0) {
					cfg.env = Object.fromEntries(item.env_vars.map(e => [e.name, e.set ? '(set)' : '(missing)']));
				}
				previewContent = JSON.stringify({ mcpServers: { [item.name]: cfg } }, null, 2);
			} else {
				let filePath = item.path;
				if (item.type === 'skill') filePath += '/SKILL.md';
				else if (item.type === 'pipeline') filePath += '/pipeline.yaml';
				// agents: path already points to .md file

				const res = await fetch(`/api/files?action=read&path=${encodeURIComponent(filePath)}`);
				if (res.ok) {
					const data = await res.json();
					previewContent = data.content || null;
				}
			}
		} catch { /* ignore */ }
		loadingPreview = false;
	}

	function closePreview() {
		selected = null;
		previewContent = null;
	}

	// Builder — create menu
	let showCreateMenu = $state(false);

	function openBuilder(type: 'pipeline' | 'skill' | 'agent' | 'script') {
		showCreateMenu = false;
		const prompts: Record<string, string> = {
			script: "I want to create a NEW SCRIPT BLOCK for the catalog. This is a BLOCK.md + run.py in catalog/scripts/. Do NOT ask what format — it is a script block. Ask me: what does it do, what inputs does it need, and what outputs does it produce.",
			agent: "I want to create a NEW AGENT BLOCK for the catalog. This is a BLOCK.md + agent.md in catalog/agents/. Do NOT ask what format — it is an agent block. Ask me: what should the agent do and what tools/skills does it need.",
			pipeline: "I want to create a NEW PIPELINE that assembles blocks from the catalog. This is a pipeline.yaml + blocks/ directory. Ask me: what steps does it need and which blocks should it use.",
			skill: "I want to create a NEW SKILL for Claude. This is a SKILL.md in ~/.claude/skills/. Ask me what the skill should do.",
		};
		const prompt = encodeURIComponent(prompts[type]);
		window.location.href = `/library/builder?type=${type}&prompt=${prompt}`;
	}

	function envStatusClass(envVars?: EnvVar[]): string {
		if (!envVars || envVars.length === 0) return '';
		const allSet = envVars.every((e) => e.set);
		return allSet ? 'text-hub-cta' : 'text-hub-warning';
	}

	function envStatusDot(envVars?: EnvVar[]): string {
		if (!envVars || envVars.length === 0) return '';
		const allSet = envVars.every((e) => e.set);
		return allSet ? 'bg-hub-cta' : 'bg-hub-warning';
	}
</script>

<svelte:head>
	<title>Library — Soul Hub</title>
</svelte:head>

<!-- Mobile: Preview overlay -->
{#if selected}
	<div class="fixed inset-0 z-50 bg-hub-bg/95 overflow-y-auto lg:hidden">
		<div class="px-4 py-6">
			<button onclick={closePreview} class="flex items-center gap-2 text-hub-muted hover:text-hub-text mb-4 cursor-pointer">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
				Back
			</button>
			{@render previewPanel()}
		</div>
	</div>
{/if}

<div class="h-full overflow-hidden flex flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-4 border-b border-hub-border flex-shrink-0">
		<div class="flex items-center gap-3">
			<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to home">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<h1 class="text-lg font-semibold text-hub-text">Library</h1>
			<span class="text-xs text-hub-dim">{filtered.length} items</span>
		</div>

		<div class="flex items-center gap-2">
			<!-- Create dropdown -->
			<div class="relative">
				<button
					onclick={() => showCreateMenu = !showCreateMenu}
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hub-cta text-hub-bg text-sm font-medium hover:bg-hub-cta-hover transition-colors cursor-pointer"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					Create
				</button>
				{#if showCreateMenu}
					<div class="absolute right-0 top-full mt-1 w-48 bg-hub-surface border border-hub-border rounded-lg shadow-xl z-50 py-1">
						<button onclick={() => openBuilder('script')} class="w-full text-left px-3 py-2 text-sm text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
							New Script Block
						</button>
						<button onclick={() => openBuilder('agent')} class="w-full text-left px-3 py-2 text-sm text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
							New Agent Block
						</button>
						<button onclick={() => openBuilder('pipeline')} class="w-full text-left px-3 py-2 text-sm text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
							New Pipeline
						</button>
						<button onclick={() => openBuilder('skill')} class="w-full text-left px-3 py-2 text-sm text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
							New Skill
						</button>
					</div>
				{/if}
			</div>

		<!-- Search -->
		<div class="relative">
			<svg class="w-4 h-4 text-hub-dim absolute left-2.5 top-1/2 -translate-y-1/2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
			</svg>
			<input
				type="text"
				placeholder="Search..."
				bind:value={search}
				class="w-40 sm:w-56 bg-hub-surface border border-hub-border rounded-md pl-8 pr-3 py-1.5 text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
			/>
		</div>
		</div>
	</div>

	<!-- Filters -->
	<div class="flex items-center gap-4 px-4 py-3 border-b border-hub-border/50 flex-shrink-0 overflow-x-auto">
		<!-- Type filters -->
		<div class="flex items-center gap-1">
			{#each [
				{ id: 'all', label: 'All', count: counts.all },
				{ id: 'script', label: 'Scripts', count: counts.script },
				{ id: 'agent', label: 'Agents', count: counts.agent },
				{ id: 'skill', label: 'Skills', count: counts.skill },
				{ id: 'pipeline', label: 'Pipelines', count: counts.pipeline },
				{ id: 'mcp', label: 'MCP', count: counts.mcp },
			] as tab (tab.id)}
				<button
					onclick={() => typeFilter = tab.id as any}
					class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap
						{typeFilter === tab.id ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}"
				>
					{tab.label}
					<span class="text-hub-dim ml-1">{tab.count}</span>
				</button>
			{/each}
		</div>

		<span class="w-px h-4 bg-hub-border"></span>

		<!-- Source filters -->
		<div class="flex items-center gap-1">
			{#each [
				{ id: 'all', label: 'All' },
				{ id: 'yours', label: 'My Library' },
				{ id: 'catalog', label: 'Catalog' },
			] as tab (tab.id)}
				<button
					onclick={() => sourceFilter = tab.id as any}
					class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap
						{sourceFilter === tab.id ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}"
				>
					{tab.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-hidden flex">
		<!-- Card list -->
		<div class="flex-1 overflow-y-auto p-4">
			{#if loading}
				<div class="text-sm text-hub-dim">Loading library...</div>
			{:else if filtered.length === 0}
				<div class="text-sm text-hub-dim">No items found.</div>
			{:else}
				<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
					{#each filtered as item (item.type + ':' + item.source + ':' + item.name)}
						<button
							onclick={() => selectItem(item)}
							class="text-left bg-hub-surface border rounded-lg p-3 transition-colors cursor-pointer
								{selected?.name === item.name && selected?.type === item.type && selected?.source === item.source
									? 'border-hub-cta/50'
									: 'border-hub-border hover:border-hub-cta/30'}"
						>
							<!-- Header -->
							<div class="flex items-center justify-between mb-1.5">
								<span class="text-sm font-medium text-hub-text truncate">{item.name}</span>
								<span class="text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ml-2
									{item.source === 'yours' ? 'text-hub-cta bg-hub-cta/10' : 'text-hub-purple bg-hub-purple/10'}">
									{item.source === 'yours' ? 'yours' : 'catalog'}
								</span>
							</div>

							<!-- Description -->
							<div class="text-xs text-hub-muted line-clamp-2 mb-2">{item.description || 'No description'}</div>

							<!-- Footer -->
							<div class="flex items-center gap-3 text-[10px] text-hub-dim">
								<!-- Type badge -->
								<span class="px-1.5 py-0.5 rounded bg-hub-card">
									{item.type}
								</span>

								<!-- Model/runtime/transport -->
								{#if item.model}
									<span>{item.model}</span>
								{/if}
								{#if item.runtime}
									<span>{item.runtime}</span>
								{/if}
								{#if item.mcpType}
									<span class="px-1 py-0.5 rounded bg-hub-info/10 text-hub-info">{item.mcpType}</span>
								{/if}
								{#if item.mcpProject}
									<span class="truncate max-w-[80px]" title={item.mcpProject}>{item.mcpProject}</span>
								{/if}

								<!-- Env status -->
								{#if item.env_vars && item.env_vars.length > 0}
									<span class="flex items-center gap-1 {envStatusClass(item.env_vars)}">
										<span class="w-1.5 h-1.5 rounded-full {envStatusDot(item.env_vars)}"></span>
										{item.env_vars.filter((e) => e.set).length}/{item.env_vars.length} env
									</span>
								{/if}

								<!-- Tags -->
								{#if item.category}
									<span>{item.category}</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Preview panel (desktop only) -->
		{#if selected}
			<div class="hidden lg:block w-96 border-l border-hub-border overflow-y-auto p-4 flex-shrink-0">
				{@render previewPanel()}
			</div>
		{/if}
	</div>
</div>

{#snippet previewPanel()}
	{#if selected}
		<div class="space-y-4">
			<!-- Header -->
			<div>
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-hub-text">{selected.name}</h2>
					<span class="text-[10px] font-medium px-1.5 py-0.5 rounded
						{selected.source === 'yours' ? 'text-hub-cta bg-hub-cta/10' : 'text-hub-purple bg-hub-purple/10'}">
						{selected.source}
					</span>
				</div>
				<span class="text-xs text-hub-dim">{selected.type}</span>
			</div>

			<!-- Description -->
			<p class="text-sm text-hub-muted">{selected.description}</p>

			<!-- Metadata -->
			<div class="space-y-2 text-xs">
				{#if selected.model}
					<div class="flex justify-between">
						<span class="text-hub-dim">Model</span>
						<span class="text-hub-text font-mono">{selected.model}</span>
					</div>
				{/if}
				{#if selected.effort}
					<div class="flex justify-between">
						<span class="text-hub-dim">Effort</span>
						<span class="text-hub-text">{selected.effort}</span>
					</div>
				{/if}
				{#if selected.runtime}
					<div class="flex justify-between">
						<span class="text-hub-dim">Runtime</span>
						<span class="text-hub-text font-mono">{selected.runtime}</span>
					</div>
				{/if}
				{#if selected.category}
					<div class="flex justify-between">
						<span class="text-hub-dim">Category</span>
						<span class="text-hub-text">{selected.category}</span>
					</div>
				{/if}
				{#if selected.dependsOn && selected.dependsOn.length > 0}
					<div class="flex justify-between">
						<span class="text-hub-dim">Depends on</span>
						<span class="text-hub-text">{selected.dependsOn.join(', ')}</span>
					</div>
				{/if}
				{#if selected.mcpType}
					<div class="flex justify-between">
						<span class="text-hub-dim">Transport</span>
						<span class="text-hub-text font-mono">{selected.mcpType}</span>
					</div>
				{/if}
				{#if selected.mcpCommand}
					<div class="flex justify-between">
						<span class="text-hub-dim">Command</span>
						<span class="text-hub-text font-mono text-right truncate ml-2">{selected.mcpCommand}</span>
					</div>
				{/if}
				{#if selected.mcpArgs && selected.mcpArgs.length > 0}
					<div>
						<span class="text-hub-dim">Args</span>
						<div class="text-hub-text font-mono text-[10px] mt-0.5 break-all">{selected.mcpArgs.join(' ')}</div>
					</div>
				{/if}
				{#if selected.mcpUrl}
					<div>
						<span class="text-hub-dim">URL</span>
						<div class="text-hub-text font-mono text-[10px] mt-0.5 break-all">{selected.mcpUrl}</div>
					</div>
				{/if}
				{#if selected.mcpProject}
					<div class="flex justify-between">
						<span class="text-hub-dim">Found in</span>
						<span class="text-hub-text">{selected.mcpProject}</span>
					</div>
				{/if}
			</div>

			<!-- Env vars -->
			{#if selected.env_vars && selected.env_vars.length > 0}
				<div>
					<h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Environment</h3>
					<div class="space-y-1.5">
						{#each selected.env_vars as env}
							<div class="flex items-center justify-between text-xs">
								<span class="font-mono text-hub-muted">{env.name}</span>
								<span class="flex items-center gap-1.5 {env.set ? 'text-hub-cta' : 'text-hub-warning'}">
									<span class="w-1.5 h-1.5 rounded-full {env.set ? 'bg-hub-cta' : 'bg-hub-warning'}"></span>
									{env.set ? 'Set' : 'Missing'}
								</span>
							</div>
						{/each}
						{#if selected.env_vars.some((e) => !e.set)}
							<a href="/settings" class="text-[10px] text-hub-warning hover:underline cursor-pointer">
								Configure in Settings > Platform Environment
							</a>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Tags -->
			{#if selected.tags && selected.tags.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each selected.tags as tag}
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
					{/each}
				</div>
			{/if}

			<!-- File preview -->
			{#if loadingPreview}
				<div class="text-xs text-hub-dim">Loading content...</div>
			{:else if previewContent}
				<div>
					<h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Content</h3>
					<pre class="text-[11px] text-hub-muted bg-hub-bg border border-hub-border rounded-md p-3 overflow-x-auto max-h-80 whitespace-pre-wrap font-mono">{previewContent}</pre>
				</div>
			{/if}

			<!-- Actions -->
			<a
				href="/library/builder?ref={encodeURIComponent(selected.name)}&reftype={selected.type}"
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-hub-cta/40 text-hub-cta hover:bg-hub-cta/10 transition-colors"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
				Open in Builder
			</a>

			<!-- Path -->
			<div class="text-[10px] text-hub-dim font-mono break-all">
				{selected.path}
			</div>
		</div>
	{/if}
{/snippet}
