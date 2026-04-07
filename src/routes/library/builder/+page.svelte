<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';
	import BuilderCatalogSidebar from '$lib/components/BuilderCatalogSidebar.svelte';
	import type { BlockManifest } from '$lib/pipeline/block.js';

	const { data } = $props();

	const type = $derived(page.url.searchParams.get('type') || 'pipeline');
	const forkName = $derived(data.forkName);
	const pipelineName = $derived(data.pipelineName);

	// Full library items (loaded client-side, merged with catalog)
	let libraryItems = $state<BlockManifest[]>(data.catalogBlocks);

	// No filtering — show everything as referenceable
	const filteredCatalog = $derived(libraryItems
	);

	const labels: Record<string, string> = {
		pipeline: 'New Pipeline',
		skill: 'New Skill',
		agent: 'New Agent',
	};

	const label = $derived(
		pipelineName
			? `Editing ${pipelineName}`
			: forkName
				? `Forking ${forkName}`
				: labels[type] || 'Builder'
	);

	// Sidebar state
	let sidebarOpen = $state(true);
	let sidebarWidth = $state(260);
	let resizing = $state(false);

	// Banner dismiss
	let bannerDismissed = $state(false);

	// Terminal ref
	let terminalRef: TerminalTabs | undefined = $state();

	// Prompt composer state
	let stagedBlocks = $state<BlockManifest[]>([]);
	let userPrompt = $state('');
	let sessionStarted = $state(false);

	const stagedBlockNames = $derived(new Set(stagedBlocks.map((b) => b.name)));

	// Context banner type
	const bannerType = $derived.by<'fork' | 'pipeline' | 'fork-error' | 'pipeline-error' | null>(() => {
		if (bannerDismissed) return null;
		if (forkName && data.forkBlockContent) return 'fork';
		if (forkName && !data.forkBlockContent) return 'fork-error';
		if (pipelineName && data.pipelineYaml) return 'pipeline';
		if (pipelineName && !data.pipelineYaml) return 'pipeline-error';
		return null;
	});

	// Pre-fill composer on mount based on context
	onMount(async () => {
		// Load full library for sidebar
		try {
			const res = await fetch('/api/library');
			if (res.ok) {
				const items = await res.json();
				const seen = new Set<string>();
				const merged: BlockManifest[] = [];
				for (const item of [...items, ...data.catalogBlocks]) {
					if (!seen.has(item.name)) {
						seen.add(item.name);
						merged.push(item);
					}
				}
				libraryItems = merged;

				// Pre-stage a referenced block from ?ref= param
				const refName = page.url.searchParams.get('ref');
				if (refName) {
					const refBlock = merged.find((b: BlockManifest) => b.name === refName);
					if (refBlock && !stagedBlockNames.has(refBlock.name)) {
						stagedBlocks = [refBlock];
					}
				}
			}
		} catch { /* use catalog blocks as fallback */ }

		// Pre-fill prompt for fork/edit contexts
		if (forkName && data.forkBlockContent) {
			userPrompt = `I want to customize the block "${forkName}". Here is the source:\n\n${data.forkBlockContent}`;
		} else if (pipelineName && data.pipelineYaml) {
			const blockNames = (data.pipelineBlocks || []).map((b: BlockManifest) => b.name).join(', ');
			userPrompt = `I'm editing "${pipelineName}".\n\nCurrent pipeline.yaml:\n\`\`\`yaml\n${data.pipelineYaml}\`\`\`\n\nInstalled blocks: ${blockNames || 'none'}`;
		}
	});

	function handleReference(block: BlockManifest) {
		if (stagedBlockNames.has(block.name)) {
			stagedBlocks = stagedBlocks.filter((b) => b.name !== block.name);
		} else {
			stagedBlocks = [...stagedBlocks, block];
		}
	}

	function removeStagedBlock(name: string) {
		stagedBlocks = stagedBlocks.filter((b) => b.name !== name);
	}

	function startSession() {
		const blockList = stagedBlocks
			.map((b) => `- "${b.name}" (${b.type}): ${b.description}\n  Path: ${(b as BlockManifest & { path?: string }).path || `catalog/${b.type === 'script' ? 'scripts' : 'agents'}/${b.name}/`}`)
			.join('\n');
		const parts: string[] = [];

		// System instruction: guide first, don't execute immediately
		parts.push(`IMPORTANT: Before creating any files, ask me clarifying questions about:
1. What are my inputs? (data I provide, files, APIs)
2. What output do I expect? (format, location)
3. Propose a plan with the structure you'll create
4. Only create files after I approve the plan.`);

		if (blockList) {
			parts.push(`I want to reference these blocks:\n${blockList}`);
		}
		if (userPrompt.trim()) {
			parts.push(`My goal: ${userPrompt.trim()}`);
		}
		const composed = parts.join('\n\n') || 'Start a new builder session.';
		sessionStarted = true;
		setTimeout(() => terminalRef?.sendToActive(composed), 3000);
	}

	function dismissBanner() {
		bannerDismissed = true;
	}

	// Resizable sidebar drag
	function startResize(e: MouseEvent) {
		e.preventDefault();
		resizing = true;
		const startX = e.clientX;
		const startWidth = sidebarWidth;

		function onMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			sidebarWidth = Math.max(180, Math.min(400, startWidth + delta));
		}

		function onUp() {
			resizing = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		}

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (meta && e.key === 'b') {
			e.preventDefault();
			sidebarOpen = !sidebarOpen;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{label} — Soul Hub Builder</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border flex-shrink-0">
		<a href="/library" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to library">
			<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
			</svg>
		</a>
		<h1 class="text-base font-semibold text-hub-text">{label}</h1>
		<span class="text-xs text-hub-dim">Builder Terminal</span>

		<!-- Sidebar toggle -->
		<div class="flex items-center gap-1 ml-auto">
			<button
				onclick={() => (sidebarOpen = !sidebarOpen)}
				class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
					{sidebarOpen ? 'bg-hub-warning/15 text-hub-warning' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
				title="Toggle catalog sidebar (Cmd+B)"
			>
				<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
				</svg>
				Catalog
			</button>
		</div>
	</div>

	<!-- Context banners -->
	{#if bannerType === 'fork'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-purple/10 border-l-4 border-hub-purple flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-purple flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 01-2 2H8a2 2 0 01-2-2V9M12 12v3"/>
				</svg>
				<span class="text-sm text-hub-text">Forking <strong class="text-hub-purple">{forkName}</strong> — customize the block in the terminal</span>
			</div>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'fork-error'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-danger/10 border-l-4 border-hub-danger flex items-center justify-between">
			<span class="text-sm text-hub-text">Block <strong class="text-hub-danger">{forkName}</strong> not found in catalog</span>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'pipeline'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-purple/10 border-l-4 border-hub-purple flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-purple flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
				</svg>
				<span class="text-sm text-hub-text">Editing <strong class="text-hub-purple">{pipelineName}</strong></span>
			</div>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'pipeline-error'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-danger/10 border-l-4 border-hub-danger flex items-center justify-between">
			<span class="text-sm text-hub-text">Pipeline <strong class="text-hub-danger">{pipelineName}</strong> not found</span>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{/if}

	<!-- Main content: sidebar + composer/terminal -->
	<div class="flex-1 min-h-0 flex">
		<!-- Catalog sidebar -->
		{#if sidebarOpen}
			<div
				class="flex-shrink-0 border-r border-hub-border overflow-hidden"
				style="width: {sidebarWidth}px"
			>
				<BuilderCatalogSidebar
					blocks={filteredCatalog}
					{stagedBlockNames}
					onReference={handleReference}
				/>
			</div>

			<!-- Resize handle -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
				onmousedown={startResize}
			></div>
		{/if}

		<!-- Right pane: composer + terminal -->
		<div class="flex-1 min-w-0 min-h-0 flex flex-col">
			<!-- Prompt Composer (visible before session starts) -->
			{#if !sessionStarted}
				<div class="flex-shrink-0 border-b border-hub-border bg-hub-surface/30 px-4 py-3">
					<!-- Staged blocks -->
					{#if stagedBlocks.length > 0}
						<div class="mb-2">
							<span class="text-[10px] font-semibold text-hub-dim uppercase tracking-wider">Blocks</span>
							<div class="flex flex-wrap gap-1.5 mt-1">
								{#each stagedBlocks as block (block.name)}
									<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-hub-cta/10 text-hub-cta border border-hub-cta/20">
										{block.name}
										<button
											onclick={() => removeStagedBlock(block.name)}
											class="ml-0.5 hover:text-hub-danger transition-colors cursor-pointer"
											aria-label="Remove {block.name}"
										>
											<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
											</svg>
										</button>
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Prompt textarea -->
					<textarea
						bind:value={userPrompt}
						placeholder="Describe what you want to build..."
						rows="3"
						class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 resize-y min-h-[60px] max-h-[200px]"
						onkeydown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
								e.preventDefault();
								startSession();
							}
						}}
					></textarea>

					<!-- Actions row -->
					<div class="flex items-center justify-between mt-2">
						<span class="text-[10px] text-hub-dim">
							{stagedBlocks.length > 0 ? `${stagedBlocks.length} block${stagedBlocks.length > 1 ? 's' : ''} staged` : 'Add blocks from the catalog or just describe your goal'}
						</span>
						<button
							onclick={startSession}
							disabled={!userPrompt.trim() && stagedBlocks.length === 0}
							class="px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer
								{!userPrompt.trim() && stagedBlocks.length === 0
									? 'bg-hub-card text-hub-dim cursor-not-allowed'
									: 'bg-hub-cta text-white hover:bg-hub-cta/90'}"
						>
							Start Session
							<span class="text-[10px] opacity-60 ml-1">{'\u2318'}Enter</span>
						</button>
					</div>
				</div>
			{/if}

			<!-- Terminal (only after session starts) -->
			{#if sessionStarted}
				<div class="flex-1 min-w-0 min-h-0 overflow-hidden">
					<TerminalTabs bind:this={terminalRef} cwd={data.cwd} projectName="_builder" />
				</div>
			{:else}
				<!-- Empty state -->
				<div class="flex-1 flex items-center justify-center text-hub-dim">
					<div class="text-center">
						<svg class="w-12 h-12 mx-auto mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
						</svg>
						<p class="text-sm">Enter a prompt or open a terminal to start</p>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
