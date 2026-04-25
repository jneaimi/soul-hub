<script lang="ts">
  import { onMount } from 'svelte';
  import { getVaultStore } from '$lib/vault/store.svelte.js';
  import VaultSidebar from '$lib/components/vault/VaultSidebar.svelte';
  import VaultGraph from '$lib/components/vault/VaultGraph.svelte';
  import VaultNoteView from '$lib/components/vault/VaultNoteView.svelte';
  import VaultNoteEditor from '$lib/components/vault/VaultNoteEditor.svelte';
  import VaultSearch from '$lib/components/vault/VaultSearch.svelte';
  import VaultNewNote from '$lib/components/vault/VaultNewNote.svelte';
  import VaultCommandBar from '$lib/components/vault/VaultCommandBar.svelte';
  import VaultSmartViews from '$lib/components/vault/VaultSmartViews.svelte';
  import VaultBulkBar from '$lib/components/vault/VaultBulkBar.svelte';
  import FilePreview from '$lib/components/FilePreview.svelte';

  const store = getVaultStore();
  let { data } = $props();

  // Local UI state only
  let view = $state<'graph' | 'note' | 'edit'>(data.initialView as 'graph' | 'note' | 'edit');
  let sidebarWidth = $state(280);
  let resizing = $state(false);
  let showNewNote = $state(false);
  let showSearch = $state(false);
  let previewFile = $state<{ path: string; name: string } | null>(null);
  let scaffoldingAll = $state(false);
  let scaffoldMessage = $state<string | null>(null);
  let allTags = $state<Record<string, number>>({});
  let isMobile = $state(false);
  let mobileView = $state<'sidebar' | 'main'>('main');
  let bulkSelected = $state<Set<string>>(new Set());

  function toggleBulk(path: string) {
    const next = new Set(bulkSelected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    bulkSelected = next;
  }

  // Note state — initialized from load() data, updated via fetchNote
  let currentNote = $state<any>(data.initialNote);
  let noteError = $state<string | null>(data.initialNoteError);

  async function fetchNote(path: string) {
    currentNote = null;
    noteError = null;
    try {
      const url = `/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url);
      if (res.ok) {
        currentNote = await res.json();
      } else {
        const body = await res.json().catch(() => ({}));
        noteError = body.error ?? `Failed to load note (${res.status})`;
      }
    } catch (e) {
      noteError = (e as Error).message || 'Network error';
    }
  }

  $effect(() => {
    const path = store.selectedPath;
    if (path && view !== 'graph') {
      fetchNote(path);
    }
  });

  function buildUrlParams(): string {
    const params = new URLSearchParams();
    if (view !== 'graph') params.set('view', view);
    if (store.selectedPath) params.set('note', store.selectedPath);
    if (store.filters.zone) params.set('zone', store.filters.zone);
    if (store.filters.type) {
      const types = Array.isArray(store.filters.type) ? store.filters.type : [store.filters.type];
      params.set('type', types.join(','));
    }
    if (store.filters.tags && store.filters.tags.length > 0) {
      params.set('tags', store.filters.tags.join(','));
    }
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
    view = 'note';
    if (isMobile) mobileView = 'main';
    noteError = null;
    store.selectNote(path);
    updateUrl();
  }

  function backToGraph() {
    view = 'graph';
    currentNote = null;
    noteError = null;
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
    await fetchNote(path);
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

  function handleFilterChange(filter: { zone?: string }) {
    // Sidebar sends zone only — merge with existing type/tag filters
    store.setFilters({
      zone: filter.zone,
      type: store.filters.type,
      tags: store.filters.tags,
    });
    replaceUrl();
  }

  function handleNavigate(path: string) {
    if (!path) { view = 'graph'; store.clearSelection(); currentNote = null; return; }
    if (path.startsWith('__file__:')) {
      const absPath = path.slice(9);
      previewFile = { path: absPath, name: absPath.split('/').pop() || absPath };
      return;
    }
    noteError = null;
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
      const decoded = decodeURIComponent(notePath);
      noteError = null;
      store.selectNote(decoded);
      view = urlView || 'note';
    } else {
      view = 'graph';
      store.clearSelection();
    }

    const urlTags = params.get('tags');
    const tagsArray = urlTags ? urlTags.split(',').filter(Boolean) : undefined;
    const typesArray = urlType ? urlType.split(',').filter(Boolean) : undefined;
    if (urlZone || typesArray || tagsArray) {
      store.setFilters({ zone: urlZone || undefined, type: typesArray, tags: tagsArray });
    }

    if (isMobile && notePath) mobileView = 'main';
  }

  onMount(() => {
    const checkMobile = () => { isMobile = window.innerWidth < 768; };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    window.addEventListener('popstate', handlePopState);

    if (new URLSearchParams(window.location.search).get('new') === '1') {
      showNewNote = true;
    }

    // Refresh vault state on tab focus + SSE reindex events
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        store.invalidate('overview', 'recent');
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    let es: EventSource | null = null;
    let sseDebounce: ReturnType<typeof setTimeout> | null = null;
    try {
      es = new EventSource('/api/vault/events');
      es.addEventListener('reindexed', () => {
        if (sseDebounce) clearTimeout(sseDebounce);
        sseDebounce = setTimeout(() => {
          store.invalidate('overview', 'recent');
        }, 300);
      });
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch { /* SSE unsupported — visibility fallback covers it */ }

    store.init().then(async () => {
      if (data.initialZone || data.initialTypes || data.initialTags) {
        store.setFilters({ zone: data.initialZone || undefined, type: data.initialTypes, tags: data.initialTags });
      }
      if (data.initialNotePath) {
        store.selectNote(data.initialNotePath);
        if (data.initialView === 'edit') view = 'edit';
      }

      try {
        const tagsRes = await fetch('/api/vault/tags');
        if (tagsRes.ok) {
          const tagsData = await tagsRes.json();
          allTags = tagsData.tags ?? tagsData;
        }
      } catch { /* silent */ }
    });

    if (isMobile && data.initialNotePath) mobileView = 'main';

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('visibilitychange', onVisible);
      if (sseDebounce) clearTimeout(sseDebounce);
      es?.close();
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

  <VaultCommandBar
    allTypes={Object.keys(store.stats?.notesByType ?? {})}
    allTags={Object.keys(allTags)}
    activeTypes={Array.isArray(store.filters.type) ? store.filters.type : store.filters.type ? [store.filters.type] : []}
    activeTags={store.filters.tags ?? []}
    onFilterChange={(f) => {
      store.setFilters({
        zone: store.filters.zone,
        type: f.type && f.type.length > 0 ? f.type : undefined,
        tags: f.tags && f.tags.length > 0 ? f.tags : undefined,
      });
      replaceUrl();
    }}
  />

  <VaultSmartViews
    activeFilters={store.filters}
    {allTags}
    onApply={(f) => {
      store.setFilters({
        zone: f.zone,
        type: f.type && f.type.length > 0 ? f.type : undefined,
        tags: f.tags && f.tags.length > 0 ? f.tags : undefined,
        since: f.since || undefined,
      });
      replaceUrl();
    }}
  />

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
          {bulkSelected}
          onSelect={handleSelectNote}
          onFilterChange={handleFilterChange}
          onToggleBulk={toggleBulk}
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
        {:else if view === 'note' && currentNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteView
                note={currentNote}
                vaultDir={store.vaultDir}
                onNavigate={handleNavigate}
                onEdit={() => { view = 'edit'; }}
                onArchive={handleArchive}
              />
            </div>
          </div>
        {:else if view === 'note' && !currentNote && noteError}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center space-y-3">
              <div class="text-hub-muted">{noteError}</div>
              <button
                class="text-sm text-hub-accent hover:underline"
                onclick={() => store.selectedPath && fetchNote(store.selectedPath)}
              >Retry</button>
            </div>
          </div>
        {:else if view === 'note' && !currentNote}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-hub-muted animate-pulse">Loading note...</div>
          </div>
        {:else if view === 'edit' && currentNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteEditor
                note={currentNote}
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

<VaultBulkBar
  selected={bulkSelected}
  onClear={() => { bulkSelected = new Set(); }}
  onDone={() => { store.invalidate('overview', 'recent'); }}
/>

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
