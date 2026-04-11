<script lang="ts">
  import { onMount } from 'svelte';

  interface SearchResult {
    path: string;
    title: string;
    type?: string;
    tags?: string[];
    project?: string;
    score: number;
    snippet?: string;
  }

  interface Props {
    onSelect: (path: string) => void;
    onClose: () => void;
  }

  let { onSelect, onClose }: Props = $props();

  let query = $state('');
  let results = $state<SearchResult[]>([]);
  let activeIndex = $state(0);
  let searching = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

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
  };

  async function search(q: string) {
    if (!q.trim()) {
      results = [];
      return;
    }
    searching = true;
    try {
      const res = await fetch(`/api/vault/notes?q=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        results = data.results;
        activeIndex = 0;
      }
    } catch {
      // silent
    } finally {
      searching = false;
    }
  }

  function handleInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(query), 200);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      onSelect(results[activeIndex].path);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function zoneFromPath(path: string): string {
    return path.split('/')[0] ?? '';
  }

  onMount(() => {
    inputEl?.focus();
    return () => clearTimeout(debounceTimer);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onkeydown={handleKeydown}>
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose}></div>

  <!-- Modal -->
  <div class="relative w-full max-w-lg mx-4 bg-hub-surface border border-hub-border rounded-xl shadow-2xl overflow-hidden">
    <!-- Search input -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border">
      <svg class="w-5 h-5 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
      </svg>
      <input
        bind:this={inputEl}
        bind:value={query}
        oninput={handleInput}
        type="text"
        placeholder="Search notes..."
        class="flex-1 bg-transparent text-hub-text text-sm outline-none placeholder:text-hub-dim"
      />
      {#if searching}
        <div class="w-4 h-4 border-2 border-hub-dim border-t-hub-cta rounded-full animate-spin"></div>
      {:else}
        <kbd class="text-xs text-hub-dim bg-hub-bg px-1.5 py-0.5 rounded">ESC</kbd>
      {/if}
    </div>

    <!-- Results -->
    {#if results.length > 0}
      <div class="max-h-80 overflow-y-auto py-1">
        {#each results as result, i}
          <button
            class="w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors {i === activeIndex ? 'bg-hub-cta/10' : 'hover:bg-hub-card'}"
            onclick={() => onSelect(result.path)}
            onmouseenter={() => { activeIndex = i; }}
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm text-hub-text truncate">{result.title}</span>
                {#if result.type}
                  <span class="text-[10px] px-1 rounded flex-shrink-0 {typeColors[result.type] ?? 'bg-hub-card text-hub-dim'}">
                    {result.type}
                  </span>
                {/if}
              </div>
              <div class="text-xs text-hub-dim mt-0.5 truncate">{zoneFromPath(result.path)} / {result.path}</div>
              {#if result.snippet}
                <div class="text-xs text-hub-muted mt-1 line-clamp-1">{result.snippet}</div>
              {/if}
            </div>
            {#if i === activeIndex}
              <kbd class="text-[10px] text-hub-dim bg-hub-bg px-1 py-0.5 rounded self-center flex-shrink-0">&#9166;</kbd>
            {/if}
          </button>
        {/each}
      </div>
    {:else if query.trim() && !searching}
      <div class="px-4 py-8 text-center text-sm text-hub-dim">No results found</div>
    {:else if !query.trim()}
      <div class="px-4 py-8 text-center text-sm text-hub-dim">Start typing to search...</div>
    {/if}

    <!-- Footer -->
    <div class="px-4 py-2 border-t border-hub-border flex items-center gap-4 text-[10px] text-hub-dim">
      <span><kbd class="bg-hub-bg px-1 rounded">&uarr;</kbd> <kbd class="bg-hub-bg px-1 rounded">&darr;</kbd> navigate</span>
      <span><kbd class="bg-hub-bg px-1 rounded">&#9166;</kbd> open</span>
      <span><kbd class="bg-hub-bg px-1 rounded">esc</kbd> close</span>
    </div>
  </div>
</div>
