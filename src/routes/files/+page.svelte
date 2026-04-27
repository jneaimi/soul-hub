<script lang="ts">
	import { onMount } from 'svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';

	interface Root {
		id: string;
		name: string;
		path: string;
		resolvedPath: string;
		showHidden: boolean;
		createdAt: string;
	}

	let roots = $state<Root[]>([]);
	let expandedRoots = $state<Record<string, boolean>>({});
	let selectedRootId = $state<string | null>(null);

	// Selected file for preview (absolute path + filename)
	let selectedFile = $state<{ path: string; name: string } | null>(null);

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let mobileTab = $state<'sidebar' | 'main'>('sidebar');

	async function loadRoots() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/settings/explorer-roots');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			roots = data.roots || [];
			// Auto-expand the first root if there's only one
			if (roots.length === 1) {
				expandedRoots = { [roots[0].id]: true };
				selectedRootId = roots[0].id;
			}
			// Apply ?path=<abs> deep link if present (e.g. from a Claude session
			// File-changes list). Find the matching root and pre-select the file.
			const params = new URLSearchParams(window.location.search);
			const deepPath = params.get('path');
			if (deepPath) {
				const matchedRoot = roots.find((r) => deepPath.startsWith(r.resolvedPath));
				if (matchedRoot) {
					selectedRootId = matchedRoot.id;
					expandedRoots = { ...expandedRoots, [matchedRoot.id]: true };
					const fileName = deepPath.substring(deepPath.lastIndexOf('/') + 1);
					selectedFile = { path: deepPath, name: fileName };
					mobileTab = 'main';
				}
			}
		} catch (e) {
			loadError = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(loadRoots);

	function toggleRoot(root: Root) {
		expandedRoots = { ...expandedRoots, [root.id]: !expandedRoots[root.id] };
		selectedRootId = root.id;
	}

	function handleFileSelect(absPath: string, fileName: string) {
		selectedFile = { path: absPath, name: fileName };
		mobileTab = 'main';
	}

	function clearSelection() {
		selectedFile = null;
		mobileTab = 'sidebar';
	}
</script>

<svelte:head>
	<title>Files — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col bg-hub-bg">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border bg-hub-surface">
		<div class="flex items-center gap-3">
			<a
				href="/"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to home"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
				<h1 class="text-base font-semibold text-hub-text">Files</h1>
			</div>
			<div class="flex-1"></div>
			{#if selectedFile}
				<div class="text-xs text-hub-dim font-mono truncate max-w-md hidden sm:block" title={selectedFile.path}>
					{selectedFile.path}
				</div>
			{/if}
			<a
				href="/settings"
				class="px-2.5 py-1 rounded-md text-xs text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="Manage roots in settings"
			>Manage roots</a>
		</div>

		<!-- Mobile tab switch -->
		<div class="flex sm:hidden mt-2 gap-1">
			<button
				type="button"
				onclick={() => (mobileTab = 'sidebar')}
				class="flex-1 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer
					{mobileTab === 'sidebar' ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-dim'}"
			>Tree</button>
			<button
				type="button"
				onclick={() => (mobileTab = 'main')}
				disabled={!selectedFile}
				class="flex-1 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer disabled:opacity-40
					{mobileTab === 'main' ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-dim'}"
			>Preview</button>
		</div>
	</header>

	<div class="flex-1 flex overflow-hidden">
		<!-- Sidebar -->
		<aside
			class="w-full sm:w-[300px] lg:w-[340px] flex-shrink-0 border-r border-hub-border overflow-y-auto bg-hub-surface
				{mobileTab === 'sidebar' ? 'flex' : 'hidden sm:flex'} flex-col"
		>
			{#if loading}
				<div class="p-6 text-center text-sm text-hub-dim">Loading roots…</div>
			{:else if loadError}
				<div class="p-6">
					<div class="text-sm text-hub-danger mb-2">Failed to load roots</div>
					<div class="text-xs text-hub-dim mb-3">{loadError}</div>
					<button onclick={loadRoots} class="text-xs text-hub-cta hover:underline cursor-pointer">Retry</button>
				</div>
			{:else if roots.length === 0}
				<div class="p-6 text-center">
					<svg class="w-10 h-10 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
					<div class="text-sm text-hub-text font-medium mb-1">No folders yet</div>
					<p class="text-xs text-hub-dim mb-4">
						Add a folder in Settings to start browsing. The explorer can read every file inside the folders you add — system paths like
						<code class="text-hub-text">~/.ssh</code> stay blocked even when covered.
					</p>
					<a href="/settings" class="inline-block px-3 py-1.5 rounded-md bg-hub-cta text-black text-xs font-medium hover:bg-hub-cta-hover transition-colors cursor-pointer">
						Open Settings
					</a>
				</div>
			{:else}
				<div class="py-2">
					{#each roots as root (root.id)}
						{@const expanded = expandedRoots[root.id]}
						<button
							type="button"
							onclick={() => toggleRoot(root)}
							class="w-full flex items-center gap-2 px-3 py-2 hover:bg-hub-card/50 transition-colors text-left cursor-pointer
								{selectedRootId === root.id ? 'bg-hub-card/40' : ''}"
						>
							<svg
								class="w-3 h-3 text-hub-dim flex-shrink-0 transition-transform {expanded ? 'rotate-90' : ''}"
								viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							>
								<polyline points="9 18 15 12 9 6"/>
							</svg>
							<svg class="w-4 h-4 text-hub-cta/80 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
							</svg>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-hub-text truncate">{root.name}</div>
								<div class="text-[10px] text-hub-dim font-mono truncate" title={root.resolvedPath}>{root.path}</div>
							</div>
						</button>
						{#if expanded}
							<div class="border-l border-hub-border/60 ml-[14px]">
								<FileTree codePath={root.resolvedPath} onFileSelect={handleFileSelect} />
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</aside>

		<!-- Main pane -->
		<main
			class="flex-1 overflow-hidden bg-hub-bg
				{mobileTab === 'main' ? 'flex' : 'hidden sm:flex'} flex-col"
		>
			{#if selectedFile}
				<FilePreview
					filePath={selectedFile.path}
					fileName={selectedFile.name}
					onClose={clearSelection}
				/>
			{:else}
				<div class="flex-1 flex items-center justify-center p-6">
					<div class="text-center max-w-sm">
						<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
						</svg>
						<div class="text-sm text-hub-muted">Select a file from the tree to preview it</div>
						<div class="text-[11px] text-hub-dim mt-2">
							Markdown, code, CSV, images, video, audio, and PDFs render inline.
						</div>
					</div>
				</div>
			{/if}
		</main>
	</div>
</div>
