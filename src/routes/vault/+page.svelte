<script lang="ts">
  import { onMount } from 'svelte';
  import { getVaultStore } from '$lib/vault/store.svelte.js';
  import VaultSidebar from '$lib/components/vault/VaultSidebar.svelte';
  import VaultGraph from '$lib/components/vault/VaultGraph.svelte';
  import VaultNoteView from '$lib/components/vault/VaultNoteView.svelte';
  import VaultNoteEditor from '$lib/components/vault/VaultNoteEditor.svelte';
  import VaultSearch from '$lib/components/vault/VaultSearch.svelte';
  import VaultNewNote from '$lib/components/vault/VaultNewNote.svelte';
  import FilePreview from '$lib/components/FilePreview.svelte';

  const store = getVaultStore();

  // Local UI state only
  let view = $state<'graph' | 'note' | 'edit'>('graph');
  let sidebarWidth = $state(280);
  let resizing = $state(false);
  let showNewNote = $state(false);
  let showSearch = $state(false);
  let previewFile = $state<{ path: string; name: string } | null>(null);
  let scaffoldingAll = $state(false);
  let scaffoldMessage = $state<string | null>(null);
  let isMobile = $state(false);
  let mobileView = $state<'sidebar' | 'main'>('main');

  function buildUrlParams(): string {
    const params = new URLSearchParams();
    if (view !== 'graph') params.set('view', view);
    if (store.selectedPath) params.set('note', store.selectedPath);
    if (store.filters.zone) params.set('zone', store.filters.zone);
    if (store.filters.type) params.set('type', store.filters.type);
    const qs = params.toString();
    return `/vault${qs ? '?' + qs : ''}`;
  }

  function updateUrl() {
    history.pushState({ view, note: store.selectedPath }, '', buildUrlParams());
  }

  function replaceUrl() {
    history.replaceState({ view, note: store.selectedPath }, '', buildUrlParams());
  }

  function handleSelectNote(path: string) {
    if (path.startsWith('__file__:')) {
      const absPath = path.slice(9);
      previewFile = { path: absPath, name: absPath.split('/').pop() || absPath };
      return;
    }
    store.selectNote(path);
    view = 'note';
    if (isMobile) mobileView = 'main';
    updateUrl();
  }

  function backToGraph() {
    view = 'graph';
    store.clearSelection();
    updateUrl();
  }

  async function handleArchive() {
    if (!store.selectedPath) return;
    const res = await fetch(`/api/vault/notes/${encodeURIComponent(store.selectedPath)}`, { method: 'DELETE' });
    if (res.ok) {
      view = 'graph';
      store.clearSelection();
      await store.invalidate('overview', 'recent', 'graph');
      updateUrl();
    }
  }

  async function handleNoteSaved(path: string) {
    view = 'note';
    await store.selectNote(path);
    await store.invalidate('overview', 'graph');
    replaceUrl();
  }

  async function handleNoteCreated(path: string) {
    showNewNote = false;
    await store.invalidate('overview', 'recent', 'graph');
    await store.selectNote(path);
    view = 'note';
    updateUrl();
  }

  function handleFilterChange(filter: { zone?: string; type?: string }) {
    store.setFilters(filter);
    replaceUrl();
  }

  function handleNavigate(path: string) {
    if (!path) { view = 'graph'; store.clearSelection(); return; }
    store.selectNote(path);
    view = 'note';
  }

  async function scaffoldAll() {
    scaffoldingAll = true;
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const data = await res.json();
      const projects = data.projects || [];

      let count = 0;
      for (const project of projects) {
        const scaffoldRes = await fetch(`/api/vault/scaffold/${encodeURIComponent(project.name)}`, { method: 'POST' });
        if (scaffoldRes.ok) {
          const data = await scaffoldRes.json();
          if (data.created.length > 0) count++;
        }
      }

      await store.invalidate('overview', 'graph');
      scaffoldMessage = count > 0 ? `Scaffolded ${count} projects` : 'All projects already scaffolded';
      setTimeout(() => { scaffoldMessage = null; }, 3000);
    } finally {
      scaffoldingAll = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'k') {
      e.preventDefault();
      showSearch = !showSearch;
    }
    if (meta && e.key === 'n') {
      e.preventDefault();
      showNewNote = true;
    }
    if (e.key === 'Escape') {
      if (showSearch) showSearch = false;
      if (showNewNote) showNewNote = false;
      if (view === 'note') backToGraph();
    }
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      sidebarWidth = Math.max(200, Math.min(400, startW + (ev.clientX - startX)));
    }
    function onUp() {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handlePopState(e: PopStateEvent) {
    const params = new URLSearchParams(window.location.search);
    const notePath = params.get('note');
    const urlView = params.get('view') as 'graph' | 'note' | 'edit' | null;
    const urlZone = params.get('zone');
    const urlType = params.get('type');

    if (notePath) {
      store.selectNote(decodeURIComponent(notePath));
      view = urlView || 'note';
    } else {
      view = 'graph';
      store.clearSelection();
    }

    if (urlZone || urlType) {
      store.setFilters({ zone: urlZone || undefined, type: urlType || undefined });
    }

    if (isMobile && notePath) mobileView = 'main';
  }

  onMount(() => {
    const checkMobile = () => { isMobile = window.innerWidth < 768; };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    window.addEventListener('popstate', handlePopState);

    store.init().then(() => {
      const params = new URLSearchParams(window.location.search);
      const notePath = params.get('note');
      const urlView = params.get('view') as 'graph' | 'note' | 'edit' | null;
      const urlZone = params.get('zone');
      const urlType = params.get('type');

      if (urlZone || urlType) {
        store.setFilters({ zone: urlZone || undefined, type: urlType || undefined });
      }
      if (notePath) {
        handleSelectNote(decodeURIComponent(notePath));
        if (urlView === 'edit') view = 'edit';
      }
    });

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('popstate', handlePopState);
      store.destroy();
    };
  });
</script>

<svelte:head><title>Vault | Soul Hub</title></svelte:head>
<svelte:window onkeydown={handleKeydown} />

<div class="h-full flex flex-col">
  <header class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-surface/50 flex items-center gap-3">
    <a href="/" class="text-hub-muted hover:text-hub-text transition-colors">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
    </a>
    <h1 class="text-lg font-semibold text-hub-text">Vault</h1>

    {#if store.stats}
      <span class="text-xs text-hub-dim">{store.stats.totalNotes} notes</span>
    {/if}

    <div class="flex-1"></div>

    <!-- Search (always visible) -->
    <button onclick={() => { showSearch = true; }} class="flex items-center gap-2 px-2 md:px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:border-hub-dim transition-colors" aria-label="Search">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
      <span class="hidden md:inline">Search</span>
      <kbd class="hidden md:inline text-xs text-hub-dim bg-hub-bg px-1 rounded">&#8984;K</kbd>
    </button>

    <!-- Desktop-only admin buttons -->
    <button onclick={scaffoldAll} disabled={scaffoldingAll}
      class="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:text-hub-text transition-colors disabled:opacity-50 cursor-pointer" aria-label="Scaffold">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
      </svg>
      {scaffoldingAll ? 'Scaffolding...' : 'Scaffold'}
    </button>

    {#if scaffoldMessage}
      <span class="hidden md:inline text-xs text-hub-cta animate-pulse">{scaffoldMessage}</span>
    {/if}

    <!-- New Note (always visible) -->
    <button onclick={() => { showNewNote = true; }} class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg bg-hub-cta text-white text-sm font-medium hover:brightness-110 transition-all" aria-label="New Note">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      <span class="hidden sm:inline">New Note</span>
    </button>

    <!-- Back to graph (when viewing note/editing) -->
    {#if view === 'note' || view === 'edit'}
      <button onclick={backToGraph} class="flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted text-sm hover:text-hub-text transition-colors" aria-label="Back to graph">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z"/></svg>
        <span class="hidden sm:inline">Graph</span>
      </button>
    {/if}
  </header>

  {#if isMobile}
    <div class="flex border-b border-hub-border bg-hub-surface/30">
      <button
        class="flex-1 py-2 text-sm text-center {mobileView === 'sidebar' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted'}"
        onclick={() => { mobileView = 'sidebar'; }}
      >Sidebar</button>
      <button
        class="flex-1 py-2 text-sm text-center {mobileView === 'main' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted'}"
        onclick={() => { mobileView = 'main'; }}
      >
        {view === 'graph' ? 'Graph' : view === 'edit' ? 'Edit' : 'Note'}
      </button>
    </div>
  {/if}

  <div class="flex-1 min-h-0 flex">
    {#if !isMobile || mobileView === 'sidebar'}
      <div
        class="flex-shrink-0 border-r border-hub-border overflow-hidden"
        class:w-full={isMobile}
        style={isMobile ? '' : `width: ${sidebarWidth}px`}
      >
        <VaultSidebar
          selectedPath={store.selectedPath}
          onSelect={handleSelectNote}
          onFilterChange={handleFilterChange}
        />
      </div>

      {#if !isMobile}
        <div
          class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
          onmousedown={startResize}
        ></div>
      {/if}
    {/if}

    {#if !isMobile || mobileView === 'main'}
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        {#if store.loading}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-hub-muted animate-pulse">Loading vault...</div>
          </div>
        {:else if store.error}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <p class="text-hub-danger mb-2">{store.error}</p>
              <button onclick={() => store.init()} class="text-sm text-hub-muted hover:text-hub-text">Retry</button>
            </div>
          </div>
        {:else if view === 'graph'}
          <div class="flex-1 min-h-0 relative bg-hub-bg">
            <VaultGraph
              nodes={store.graphNodes}
              edges={store.graphEdges}
              onNodeClick={handleSelectNote}
            />
          </div>
        {:else if view === 'note' && store.selectedNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteView
                note={store.selectedNote}
                vaultDir={store.vaultDir}
                onNavigate={handleNavigate}
                onEdit={() => { view = 'edit'; }}
                onArchive={handleArchive}
              />
            </div>
          </div>
        {:else if view === 'edit' && store.selectedNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteEditor
                note={store.selectedNote}
                onSave={handleNoteSaved}
                onCancel={() => { view = 'note'; }}
              />
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if showSearch}
  <VaultSearch
    onSelect={(path) => { showSearch = false; handleSelectNote(path); }}
    onClose={() => { showSearch = false; }}
  />
{/if}

{#if showNewNote}
  <VaultNewNote
    zones={store.zones}
    onCreated={handleNoteCreated}
    onClose={() => { showNewNote = false; }}
  />
{/if}

{#if previewFile}
  <FilePreview
    filePath={previewFile.path}
    fileName={previewFile.name}
    onClose={() => { previewFile = null; }}
  />
{/if}
