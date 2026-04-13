<script lang="ts">
  import { onMount } from 'svelte';
  import { getVaultStore } from '$lib/vault/store.svelte.js';

  const store = getVaultStore();

  interface Props {
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onFilterChange: (filter: { zone?: string; type?: string }) => void;
  }

  let { selectedPath, onSelect, onFilterChange }: Props = $props();

  let activeZone = $state<string | null>(null);
  let activeType = $state<string | null>(null);
  let sidebarTab = $state<'overview' | 'files'>('overview');

  // File browser state
  interface FileEntry { name: string; type: string; size?: number; }
  let fileRoot = $state<'vault' | 'outputs'>('vault');
  let currentDir = $state('');
  let dirEntries = $state<FileEntry[]>([]);
  let loadingDir = $state(false);

  function getBasePath(): string {
    if (fileRoot === 'outputs' && store.pipelinesDir) return store.pipelinesDir;
    return store.vaultDir;
  }

  async function browseDir(dir: string) {
    if (!getBasePath()) return;
    loadingDir = true;
    currentDir = dir;
    try {
      const fullPath = getBasePath() + (dir ? '/' + dir : '');
      const res = await fetch(`/api/files?path=${encodeURIComponent(fullPath)}`);
      if (res.ok) {
        const data = await res.json();
        let entries = (data.entries || []) as FileEntry[];
        if (fileRoot === 'vault') {
          entries = entries.filter((e: FileEntry) => !e.name.startsWith('.') && e.name !== 'CLAUDE.md');
        }
        if (fileRoot === 'outputs' && !dir) {
          const withOutput: FileEntry[] = [];
          for (const e of entries) {
            if (e.type !== 'dir') continue;
            const outRes = await fetch(`/api/files?path=${encodeURIComponent(store.pipelinesDir + '/' + e.name + '/output')}`);
            if (outRes.ok) withOutput.push(e);
          }
          entries = withOutput;
        }
        dirEntries = entries.sort((a: FileEntry, b: FileEntry) => {
          const aDir = a.type === 'dir';
          const bDir = b.type === 'dir';
          if (aDir !== bDir) return aDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
    } catch { dirEntries = []; }
    finally { loadingDir = false; }
  }

  function handleFileClick(entry: FileEntry) {
    if (entry.type === 'dir') {
      if (fileRoot === 'outputs' && !currentDir) {
        browseDir(entry.name + '/output');
      } else {
        browseDir(currentDir ? `${currentDir}/${entry.name}` : entry.name);
      }
    } else if (fileRoot === 'vault') {
      const fullPath = currentDir ? `${currentDir}/${entry.name}` : entry.name;
      onSelect(fullPath);
    } else {
      const absPath = getBasePath() + '/' + (currentDir ? `${currentDir}/${entry.name}` : entry.name);
      onSelect('__file__:' + absPath);
    }
  }

  function navigateUp() {
    const parts = currentDir.split('/');
    parts.pop();
    browseDir(parts.join('/'));
  }

  function switchFileRoot(root: 'vault' | 'outputs') {
    fileRoot = root;
    currentDir = '';
    dirEntries = [];
    browseDir('');
  }

  const zoneIcons: Record<string, string> = {
    projects: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    patterns: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
    research: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    inbox: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
    archive: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  };

  const zoneColors: Record<string, string> = {
    projects: 'text-indigo-400',
    patterns: 'text-violet-400',
    research: 'text-cyan-400',
    inbox: 'text-amber-400',
    archive: 'text-gray-400',
  };

  const typeColors: Record<string, string> = {
    learning: 'bg-emerald-500/20 text-emerald-400',
    decision: 'bg-amber-500/20 text-amber-400',
    debugging: 'bg-red-500/20 text-red-400',
    pattern: 'bg-violet-500/20 text-violet-400',
    research: 'bg-cyan-500/20 text-cyan-400',
    output: 'bg-blue-500/20 text-blue-400',
    daily: 'bg-gray-500/20 text-gray-400',
    snippet: 'bg-pink-500/20 text-pink-400',
    report: 'bg-teal-500/20 text-teal-400',
    index: 'bg-gray-500/20 text-gray-400',
    adr: 'bg-amber-500/20 text-amber-400',
    analytics: 'bg-cyan-500/20 text-cyan-400',
  };

  function relativeTime(mtime: number): string {
    const diff = Date.now() - mtime;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function selectZone(zone: string | null) {
    activeZone = zone;
    onFilterChange({ zone: zone ?? undefined, type: activeType ?? undefined });
  }

  function toggleType(type: string) {
    activeType = activeType === type ? null : type;
    onFilterChange({ zone: activeZone ?? undefined, type: activeType ?? undefined });
  }
</script>

<div class="h-full flex flex-col bg-hub-surface overflow-hidden">
  <!-- Tab switcher -->
  <div class="flex-shrink-0 flex border-b border-hub-border">
    <button
      class="flex-1 py-2 text-xs text-center font-medium transition-colors {sidebarTab === 'overview' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted hover:text-hub-text'}"
      onclick={() => { sidebarTab = 'overview'; }}
    >Overview</button>
    <button
      class="flex-1 py-2 text-xs text-center font-medium transition-colors {sidebarTab === 'files' ? 'text-hub-cta border-b-2 border-hub-cta' : 'text-hub-muted hover:text-hub-text'}"
      onclick={() => { sidebarTab = 'files'; if (dirEntries.length === 0) browseDir(''); }}
    >Files</button>
  </div>

  <div class="flex-1 overflow-y-auto">
  {#if sidebarTab === 'files'}
    <!-- File browser -->
    <div class="p-3">
      <!-- Root switcher -->
      {#if store.pipelinesDir}
        <div class="flex gap-1 mb-2">
          <button
            class="flex-1 text-[11px] py-1 rounded transition-colors {fileRoot === 'vault' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim hover:text-hub-muted'}"
            onclick={() => switchFileRoot('vault')}
          >Vault</button>
          <button
            class="flex-1 text-[11px] py-1 rounded transition-colors {fileRoot === 'outputs' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim hover:text-hub-muted'}"
            onclick={() => switchFileRoot('outputs')}
          >Pipeline Outputs</button>
        </div>
      {/if}

      <div class="flex items-center gap-2 mb-2">
        {#if currentDir}
          <button onclick={navigateUp} class="text-hub-muted hover:text-hub-text text-sm" aria-label="Go up">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          </button>
        {/if}
        <span class="text-xs text-hub-dim truncate">/{currentDir || (fileRoot === 'outputs' ? 'pipelines' : 'vault')}</span>
      </div>

      {#if loadingDir}
        <div class="text-xs text-hub-dim animate-pulse py-2">Loading...</div>
      {:else if dirEntries.length === 0}
        <div class="text-xs text-hub-dim py-2">Empty folder</div>
      {:else}
        <div class="space-y-0.5">
          {#each dirEntries as entry}
            <button
              class="w-full text-left px-2 py-1.5 rounded text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors flex items-center gap-2"
              onclick={() => handleFileClick(entry)}
            >
              {#if entry.type === 'dir'}
                <svg class="w-4 h-4 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              {:else}
                <svg class="w-4 h-4 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              {/if}
              <span class="truncate">{entry.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- Overview tab (zones, types, recent) -->
    <div class="p-3">
      <h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Zones</h3>
      <button
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors {activeZone === null ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
        onclick={() => selectZone(null)}
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
        <span>All</span>
        {#if store.stats}
          <span class="ml-auto text-xs text-hub-dim">{store.stats.totalNotes}</span>
        {/if}
      </button>

      {#if store.stats}
        {#each Object.entries(store.stats.notesByZone) as [zone, count]}
          <button
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors {activeZone === zone ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
            onclick={() => selectZone(zone)}
          >
            <svg class="w-4 h-4 {zoneColors[zone] ?? 'text-hub-dim'}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={zoneIcons[zone] ?? 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'} />
            </svg>
            <span class="capitalize">{zone}</span>
            <span class="ml-auto text-xs text-hub-dim">{count}</span>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Type filters -->
    {#if store.stats && Object.keys(store.stats.notesByType).length > 0}
      <div class="px-3 pb-3">
        <h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Types</h3>
        <div class="flex flex-wrap gap-1.5">
          {#each Object.entries(store.stats.notesByType) as [type, count]}
            <button
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors {activeType === type ? 'ring-1 ring-hub-cta ' : ''}{typeColors[type] ?? 'bg-hub-card text-hub-muted'}"
              onclick={() => toggleType(type)}
            >
              {type}
              <span class="opacity-60">{count}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Divider -->
    <div class="border-t border-hub-border mx-3"></div>

    <!-- Recent notes -->
    <div class="p-3">
      <h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Recent</h3>
      {#if store.recentNotes.length === 0}
        <div class="text-xs text-hub-dim py-2">No notes yet</div>
      {:else}
        <div class="space-y-0.5">
          {#each store.recentNotes as note}
            <button
              class="w-full text-left px-2 py-1.5 rounded text-sm transition-colors group {selectedPath === note.path ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
              onclick={() => onSelect(note.path)}
            >
              <div class="flex items-center gap-1.5">
                <span class="truncate flex-1">{note.title}</span>
              </div>
              <div class="flex items-center gap-1.5 mt-0.5">
                {#if note.meta?.type}
                  <span class="text-[10px] px-1 rounded {typeColors[note.meta.type] ?? 'bg-hub-card text-hub-dim'}">
                    {note.meta.type}
                  </span>
                {/if}
                <span class="text-[10px] text-hub-dim ml-auto">{relativeTime(note.mtime)}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  </div>

  <!-- Stats footer -->
  {#if store.stats}
    <div class="flex-shrink-0 border-t border-hub-border px-3 py-2 text-[10px] text-hub-dim flex items-center gap-3">
      <span>{store.stats.totalLinks} links</span>
      {#if store.stats.unresolvedLinks > 0}
        <span class="text-hub-warning">{store.stats.unresolvedLinks} unresolved</span>
      {/if}
      {#if store.stats.orphanNotes > 0}
        <span class="text-hub-danger">{store.stats.orphanNotes} orphans</span>
      {/if}
    </div>
  {/if}
</div>
