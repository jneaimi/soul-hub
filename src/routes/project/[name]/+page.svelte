<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';
	import CatalogPanel from '$lib/components/CatalogPanel.svelte';
	import ProjectInfoDropdown from '$lib/components/ProjectInfoDropdown.svelte';

	const { data } = $props();
	const projectName = $derived(page.params.name ?? '');

	// Panel state (defaults, overridden from localStorage in onMount)
	let sidePanel = $state<'code' | 'brain' | 'catalog' | null>('code');
	let sidePanelWidth = $state(260);
	let resizing = $state(false);

	// File preview state
	let previewFile = $state<{ path: string; name: string } | null>(null);

	// Mobile state
	let isMobile = $state(false);
	let mobileView = $state<'terminal' | 'files' | 'catalog'>('terminal');

	// Git state
	let gitInfo = $state<{
		isGit: boolean;
		branch: string | null;
		dirty: boolean;
		uncommittedCount: number;
		recentCommits: { hash: string; message: string; relativeTime: string }[];
	} | null>(null);

	// Component refs
	let terminalTabsRef: TerminalTabs | undefined = $state();

	onMount(() => {
		// Load UI prefs from localStorage
		try {
			const prefs = localStorage.getItem('soul-hub-prefs');
			if (prefs) {
				const p = JSON.parse(prefs);
				if (p.defaultPanel) {
					sidePanel = p.defaultPanel === 'closed' ? null : p.defaultPanel;
				}
				if (p.panelWidth) sidePanelWidth = p.panelWidth;
			}
		} catch { /* use defaults */ }

		// Fetch git info
		if (data.devPath) {
			fetch(`/api/git?path=${encodeURIComponent(data.devPath)}`)
				.then((r) => r.ok ? r.json() : null)
				.then((d) => { if (d) gitInfo = d; })
				.catch(() => {});
		}

		const checkMobile = () => {
			isMobile = window.innerWidth < 768;
			if (isMobile) sidePanel = null;
		};
		checkMobile();
		window.addEventListener('resize', checkMobile);
		return () => window.removeEventListener('resize', checkMobile);
	});

	function handleFileSelect(path: string, fileName: string) {
		previewFile = { path, name: fileName };
	}

	function closePreview() {
		previewFile = null;
	}

	// Resizable panel drag
	function startResize(e: MouseEvent) {
		e.preventDefault();
		resizing = true;
		const startX = e.clientX;
		const startWidth = sidePanelWidth;

		function onMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			sidePanelWidth = Math.max(180, Math.min(500, startWidth + delta));
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
		if (!meta) return;

		if (e.key === 'b') {
			e.preventDefault();
			if (isMobile) {
				mobileView = mobileView === 'files' ? 'terminal' : 'files';
			} else {
				sidePanel = sidePanel ? null : 'code';
			}
		}
	}

	// Toggle side panel tab — clicking the active tab closes it
	function setSidePanel(tab: 'code' | 'brain' | 'catalog') {
		sidePanel = sidePanel === tab ? null : tab;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{projectName} — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-surface/50">
		<div class="flex items-center gap-3">
			<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>

			<ProjectInfoDropdown
				{projectName}
				devPath={data.devPath}
				brainPath={data.brainPath}
				{gitInfo}
			/>

			<!-- Git branch badge -->
			{#if gitInfo?.isGit && gitInfo.branch}
				<span class="hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-hub-purple/10 text-hub-purple text-xs font-mono">
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
					{gitInfo.branch}
					{#if gitInfo.dirty}
						<span class="w-1.5 h-1.5 rounded-full bg-hub-warning" title="{gitInfo.uncommittedCount} uncommitted"></span>
					{/if}
				</span>
			{/if}

			<!-- Desktop panel toggles -->
			<div class="hidden md:flex items-center gap-1 ml-auto">
				{#if data.devPath || data.brainPath}
					<button
						onclick={() => setSidePanel('code')}
						class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
							{sidePanel === 'code' || sidePanel === 'brain' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
						title="Toggle file browser (Cmd+B)"
					>
						<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
						Files
					</button>
				{/if}
				<button
					onclick={() => setSidePanel('catalog')}
					class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
						{sidePanel === 'catalog' ? 'bg-hub-warning/15 text-hub-warning' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
					title="Toggle catalog"
				>
					<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
					Catalog
				</button>
			</div>

			<!-- Mobile view toggles -->
			<div class="flex md:hidden items-center gap-1 ml-auto">
				<button
					onclick={() => mobileView = 'terminal'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'terminal' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
				</button>
				<button
					onclick={() => mobileView = 'files'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'files' ? 'bg-hub-info/15 text-hub-info' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
				</button>
				<button
					onclick={() => mobileView = 'catalog'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'catalog' ? 'bg-hub-warning/15 text-hub-warning' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
				</button>
			</div>
		</div>
	</header>

	<!-- Main content area -->
	<div class="flex-1 min-h-0 flex">
		<!-- Desktop: Side panel -->
		{#if !isMobile && sidePanel}
			<div
				class="flex-shrink-0 border-r border-hub-border overflow-hidden"
				style="width: {sidePanelWidth}px"
			>
				{#if sidePanel === 'code' || sidePanel === 'brain'}
					<FileTree
						codePath={data.devPath}
						brainPath={data.brainPath}
						onFileSelect={handleFileSelect}
					/>
				{:else if sidePanel === 'catalog'}
					<CatalogPanel
						{projectName}
						codePath={data.devPath}
					/>
				{/if}
			</div>

			<!-- Resize handle -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
				onmousedown={startResize}
			></div>
		{/if}

		<!-- Terminal area (desktop) / Active view (mobile) -->
		<div class="flex-1 min-w-0 min-h-0">
			{#if isMobile}
				<!-- Mobile views -->
				{#if mobileView === 'terminal'}
					<TerminalTabs
						bind:this={terminalTabsRef}
						cwd={data.cwd}
						{projectName}
					/>
				{:else if mobileView === 'files'}
					<FileTree
						codePath={data.devPath}
						brainPath={data.brainPath}
						onFileSelect={handleFileSelect}
					/>
				{:else if mobileView === 'catalog'}
					<CatalogPanel
						{projectName}
						codePath={data.devPath}
					/>
				{/if}
			{:else}
				<!-- Desktop: terminal always visible -->
				<TerminalTabs
					bind:this={terminalTabsRef}
					cwd={data.cwd}
					{projectName}
				/>
			{/if}
		</div>
	</div>
</div>

<!-- File preview slide-over -->
{#if previewFile}
	<FilePreview
		filePath={previewFile.path}
		fileName={previewFile.name}
		onClose={closePreview}
	/>
{/if}
