<script lang="ts">
  import { onMount } from 'svelte';
  import VaultSidebar from '$lib/components/vault/VaultSidebar.svelte';
  import VaultGraph from '$lib/components/vault/VaultGraph.svelte';
  import VaultNoteView from '$lib/components/vault/VaultNoteView.svelte';
  import VaultNoteEditor from '$lib/components/vault/VaultNoteEditor.svelte';
  import VaultSearch from '$lib/components/vault/VaultSearch.svelte';
  import VaultNewNote from '$lib/components/vault/VaultNewNote.svelte';
  import FilePreview from '$lib/components/FilePreview.svelte';
  import type { VaultNote } from '$lib/vault/types';

  interface VaultStats {
    totalNotes: number;
    notesByType: Record<string, number>;
    notesByZone: Record<string, number>;
    totalLinks: number;
    unresolvedLinks: number;
    orphanNotes: number;
    lastIndexed: string;
  }

  interface VaultZone {
    path: string;
    allowedTypes: string[];
    requireTemplate: boolean;
    requiredFields: string[];
  }

  interface GraphNode {
    id: string;
    label: string;
    type?: string;
    zone: string;
    size: number;
    color: string;
  }

  interface GraphEdge {
    source: string;
    target: string;
    label?: string;
  }

  let stats = $state<VaultStats | null>(null);
  let zones = $state<VaultZone[]>([]);
  let vaultDir = $state('');
  let pipelinesDir = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  let view = $state<'graph' | 'note' | 'edit'>('graph');
  let selectedNote = $state<VaultNote | null>(null);
  let selectedPath = $state<string | null>(null);

  let graphNodes = $state<GraphNode[]>([]);
  let graphEdges = $state<GraphEdge[]>([]);

  let sidebarWidth = $state(280);
  let resizing = $state(false);
  let sidebarFilter = $state<{ zone?: string; type?: string; tags?: string[] }>({});

  let showNewNote = $state(false);
  let showSearch = $state(false);
  let previewFile = $state<{ path: string; name: string } | null>(null);

  let scaffoldingAll = $state(false);
  let scaffoldMessage = $state<string | null>(null);

  let isMobile = $state(false);
  let mobileView = $state<'sidebar' | 'main'>('main');

  async function loadVault() {
    try {
      const res = await fetch('/api/vault');
      if (!res.ok) {
        error = 'Vault not ready';
        return;
      }
      const data = await res.json();
      stats = data.stats;
      zones = data.zones;
      vaultDir = data.paths?.vaultDir || '';
      pipelinesDir = data.paths?.pipelinesDir || '';
      error = null;
    } catch {
      error = 'Failed to load vault';
    } finally {
      loading = false;
    }
  }

  async function loadGraph(opts?: { zone?: string; type?: string; project?: string }) {
    const params = new URLSearchParams();
    if (opts?.zone) params.set('zone', opts.zone);
    if (opts?.project) params.set('project', opts.project);
    const url = `/api/vault/graph${params.toString() ? '?' + params : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      let nodes = data.nodes;
      let edges = data.edges;
      // Client-side type filter (API doesn't support type param)
      if (opts?.type) {
        const typeFilter = opts.type;
        const filteredIds = new Set(nodes.filter((n: GraphNode) => n.type === typeFilter).map((n: GraphNode) => n.id));
        nodes = nodes.filter((n: GraphNode) => filteredIds.has(n.id));
        edges = edges.filter((e: GraphEdge) => filteredIds.has(e.source) && filteredIds.has(e.target));
      }
      graphNodes = nodes;
      graphEdges = edges;
    }
  }

  async function selectNote(path: string) {
    // Pipeline output files use absolute path with __file__: prefix — open in FilePreview
    if (path.startsWith('__file__:')) {
      const absPath = path.slice(9);
      const fileName = absPath.split('/').pop() || absPath;
      previewFile = { path: absPath, name: fileName };
      return;
    }
    selectedPath = path;
    view = 'note';
    const res = await fetch(`/api/vault/notes/${encodeURIComponent(path)}`);
    if (res.ok) {
      selectedNote = await res.json();
    }
  }

  function backToGraph() {
    view = 'graph';
    selectedNote = null;
    selectedPath = null;
  }

  async function handleArchive() {
    if (!selectedPath) return;
    const res = await fetch(`/api/vault/notes/${encodeURIComponent(selectedPath)}`, { method: 'DELETE' });
    if (res.ok) {
      backToGraph();
      await loadVault();
      await loadGraph(sidebarFilter);
    }
  }

  async function handleNoteSaved(path: string) {
    view = 'note';
    await selectNote(path);
    await loadVault();
  }

  function handleNavigate(path: string) {
    if (!path) { backToGraph(); return; }
    selectNote(path);
  }

  async function handleNoteCreated(path: string) {
    showNewNote = false;
    await loadVault();
    await loadGraph(sidebarFilter);
    await selectNote(path);
  }

  async function handleFilterChange(filter: { zone?: string; type?: string }) {
    sidebarFilter = filter;
    await loadGraph(filter);
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

      await loadVault();
      await loadGraph();
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

  onMount(() => {
    const checkMobile = () => {
      isMobile = window.innerWidth < 768;
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    loadVault().then(() => {
      loadGraph();
      // Deep link: ?note=path opens a specific note
      const params = new URLSearchParams(window.location.search);
      const notePath = params.get('note');
      if (notePath) {
        selectNote(decodeURIComponent(notePath));
        if (isMobile) mobileView = 'main';
      }
    });
    return () => window.removeEventListener('resize', checkMobile);
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

    {#if stats}
      <span class="text-xs text-hub-dim">{stats.totalNotes} notes</span>
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
          {stats}
          {zones}
          {vaultDir}
          {pipelinesDir}
          selectedPath={selectedPath}
          onSelect={selectNote}
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
        {#if loading}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-hub-muted animate-pulse">Loading vault...</div>
          </div>
        {:else if error}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <p class="text-hub-danger mb-2">{error}</p>
              <button onclick={loadVault} class="text-sm text-hub-muted hover:text-hub-text">Retry</button>
            </div>
          </div>
        {:else if view === 'graph'}
          <div class="flex-1 min-h-0 relative bg-hub-bg">
            <VaultGraph
              nodes={graphNodes}
              edges={graphEdges}
              onNodeClick={selectNote}
            />
          </div>
        {:else if view === 'note' && selectedNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteView
                note={selectedNote}
                {vaultDir}
                onNavigate={handleNavigate}
                onEdit={() => { view = 'edit'; }}
                onArchive={handleArchive}
              />
            </div>
          </div>
        {:else if view === 'edit' && selectedNote}
          <div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div class="max-w-4xl mx-auto">
              <VaultNoteEditor
                note={selectedNote}
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
    onSelect={(path) => { showSearch = false; selectNote(path); }}
    onClose={() => { showSearch = false; }}
  />
{/if}

{#if showNewNote}
  <VaultNewNote
    {zones}
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

