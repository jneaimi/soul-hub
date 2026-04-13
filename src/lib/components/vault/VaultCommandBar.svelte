<script lang="ts">
  interface Props {
    allTypes: string[];
    allTags: string[];
    activeTypes: string[];
    activeTags: string[];
    onFilterChange: (filters: { type?: string[]; tags?: string[] }) => void;
  }

  let { allTypes, allTags, activeTypes, activeTags, onFilterChange }: Props = $props();

  let showTypePopover = $state(false);
  let showTagPopover = $state(false);
  let typeSearch = $state('');
  let tagSearch = $state('');

  // Click-outside action
  function clickOutside(node: HTMLElement, callback: () => void) {
    function handleClick(e: MouseEvent) {
      if (!node.contains(e.target as Node)) callback();
    }
    document.addEventListener('click', handleClick, true);
    return { destroy() { document.removeEventListener('click', handleClick, true); } };
  }

  // Type categories
  const typeCategories: Record<string, string[]> = {
    Knowledge: ['research', 'pattern', 'snippet', 'decision', 'review', 'recipe', 'report', 'analysis', 'evaluation', 'data-pack', 'reference', 'guide', 'wiki'],
    Content: ['draft', 'social-draft', 'social-post', 'article-draft', 'video-script', 'video-script-draft', 'content-menu', 'content-prep', 'ideas', 'daily-quote', 'media-asset', 'insight-draft', 'miner-report', 'signal-report', 'strategist-prep'],
    Project: ['project', 'learning', 'debugging', 'output', 'index', 'task', 'design', 'requirements'],
    Operations: ['agent-profile', 'config', 'session-log', 'playbook', 'system-config', 'identity', 'boundaries'],
  };

  let hasActiveFilters = $derived(activeTypes.length > 0 || activeTags.length > 0);

  let filteredTypesBySearch = $derived.by(() => {
    const q = typeSearch.toLowerCase();
    if (!q) return allTypes;
    return allTypes.filter(t => t.toLowerCase().includes(q));
  });

  let filteredTagsBySearch = $derived.by(() => {
    const q = tagSearch.toLowerCase();
    if (!q) return allTags;
    return allTags.filter(t => t.toLowerCase().includes(q));
  });

  // Group available types by category, filtering by search
  let groupedTypes = $derived.by(() => {
    const available = new Set(filteredTypesBySearch);
    const groups: { name: string; types: string[] }[] = [];
    const categorized = new Set<string>();

    for (const [cat, types] of Object.entries(typeCategories)) {
      const matching = types.filter(t => available.has(t));
      if (matching.length > 0) {
        groups.push({ name: cat, types: matching });
        matching.forEach(t => categorized.add(t));
      }
    }

    // Uncategorized types
    const uncategorized = filteredTypesBySearch.filter(t => !categorized.has(t));
    if (uncategorized.length > 0) {
      groups.push({ name: 'Other', types: uncategorized });
    }

    return groups;
  });

  function emit(overrides: Partial<{ type?: string[]; tags?: string[] }> = {}) {
    onFilterChange({
      type: overrides.type !== undefined ? overrides.type : activeTypes,
      tags: overrides.tags !== undefined ? overrides.tags : activeTags,
    });
  }

  function toggleType(t: string) {
    const next = activeTypes.includes(t)
      ? activeTypes.filter(x => x !== t)
      : [...activeTypes, t];
    emit({ type: next });
  }

  function toggleTag(t: string) {
    const next = activeTags.includes(t)
      ? activeTags.filter(x => x !== t)
      : [...activeTags, t];
    emit({ tags: next });
  }

  function removeFilter(kind: 'type' | 'tag', value: string) {
    if (kind === 'type') emit({ type: activeTypes.filter(x => x !== value) });
    else emit({ tags: activeTags.filter(x => x !== value) });
  }

  function clearAll() {
    onFilterChange({ type: [], tags: [] });
  }

  function handleKeydown(e: KeyboardEvent, toggle: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape') {
      showTypePopover = false;
      showTagPopover = false;
    }
  }
</script>

<div class="flex-shrink-0 px-4 py-2 border-b border-hub-border bg-hub-surface/50">
  <!-- Filter row -->
  <div class="flex items-center gap-3 flex-wrap">
    <!-- Type multi-select -->
    <div class="relative" use:clickOutside={() => { showTypePopover = false; typeSearch = ''; }}>
      <button
        class="flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-lg bg-hub-card border border-hub-border text-sm cursor-pointer transition-colors duration-150 hover:border-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none {activeTypes.length > 0 ? 'text-hub-text' : 'text-hub-muted'}"
        onclick={() => { showTypePopover = !showTypePopover; showZoneDropdown = false; showTagPopover = false; }}
        onkeydown={(e) => handleKeydown(e, () => { showTypePopover = !showTypePopover; })}
        aria-expanded={showTypePopover}
        aria-haspopup="listbox"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        <span>Type: {activeTypes.length > 0 ? `${activeTypes.length} selected` : 'Select...'}</span>
        <svg class="w-3.5 h-3.5 text-hub-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showTypePopover}
        <div class="absolute left-0 top-full mt-1 z-50 w-[260px] rounded-lg bg-hub-card border border-hub-border shadow-lg">
          <div class="p-2 border-b border-hub-border">
            <input
              type="text"
              bind:value={typeSearch}
              placeholder="Filter types..."
              class="w-full px-2 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text placeholder:text-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div class="max-h-64 overflow-y-auto py-1">
            {#each groupedTypes as group}
              <div class="px-3 pt-2 pb-1 text-xs font-medium text-hub-dim uppercase tracking-wider">{group.name}</div>
              {#each group.types as t}
                <label class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors duration-150 hover:bg-hub-surface/50">
                  <input
                    type="checkbox"
                    checked={activeTypes.includes(t)}
                    onchange={() => toggleType(t)}
                    class="rounded border-hub-border text-hub-cta focus:ring-blue-500 cursor-pointer"
                  />
                  <span class="{activeTypes.includes(t) ? 'text-hub-text' : 'text-hub-muted'}">{t}</span>
                </label>
              {/each}
            {/each}
            {#if groupedTypes.length === 0}
              <div class="px-3 py-2 text-sm text-hub-dim">No types match</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <!-- Tag multi-select -->
    <div class="relative" use:clickOutside={() => { showTagPopover = false; tagSearch = ''; }}>
      <button
        class="flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-lg bg-hub-card border border-hub-border text-sm cursor-pointer transition-colors duration-150 hover:border-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none {activeTags.length > 0 ? 'text-hub-text' : 'text-hub-muted'}"
        onclick={() => { showTagPopover = !showTagPopover; showZoneDropdown = false; showTypePopover = false; }}
        onkeydown={(e) => handleKeydown(e, () => { showTagPopover = !showTagPopover; })}
        aria-expanded={showTagPopover}
        aria-haspopup="listbox"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        <span>Tags: {activeTags.length > 0 ? `${activeTags.length} selected` : 'Select...'}</span>
        <svg class="w-3.5 h-3.5 text-hub-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showTagPopover}
        <div class="absolute left-0 top-full mt-1 z-50 w-[240px] rounded-lg bg-hub-card border border-hub-border shadow-lg">
          <div class="p-2 border-b border-hub-border">
            <input
              type="text"
              bind:value={tagSearch}
              placeholder="Filter tags..."
              class="w-full px-2 py-1.5 text-sm rounded bg-hub-bg border border-hub-border text-hub-text placeholder:text-hub-dim focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div class="max-h-64 overflow-y-auto py-1">
            {#each filteredTagsBySearch as t}
              <label class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors duration-150 hover:bg-hub-surface/50">
                <input
                  type="checkbox"
                  checked={activeTags.includes(t)}
                  onchange={() => toggleTag(t)}
                  class="rounded border-hub-border text-hub-cta focus:ring-blue-500 cursor-pointer"
                />
                <span class="{activeTags.includes(t) ? 'text-hub-text' : 'text-hub-muted'}">{t}</span>
              </label>
            {/each}
            {#if filteredTagsBySearch.length === 0}
              <div class="px-3 py-2 text-sm text-hub-dim">No tags match</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Active filter pills -->
  {#if hasActiveFilters}
    <div class="flex items-center gap-2 mt-2 flex-wrap">
      {#each activeTypes as t}
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-violet-500/15 text-violet-400 text-xs font-medium">
          type: {t}
          <button
            class="ml-0.5 hover:text-violet-200 cursor-pointer transition-colors duration-150 focus:ring-2 focus:ring-blue-500 focus:outline-none rounded"
            onclick={() => removeFilter('type', t)}
            aria-label="Remove type filter {t}"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      {/each}

      {#each activeTags as t}
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-400 text-xs font-medium">
          tag: {t}
          <button
            class="ml-0.5 hover:text-emerald-200 cursor-pointer transition-colors duration-150 focus:ring-2 focus:ring-blue-500 focus:outline-none rounded"
            onclick={() => removeFilter('tag', t)}
            aria-label="Remove tag filter {t}"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      {/each}

      <button
        class="px-2 py-1 rounded-md text-xs text-hub-muted hover:text-hub-text cursor-pointer transition-colors duration-150 focus:ring-2 focus:ring-blue-500 focus:outline-none"
        onclick={clearAll}
      >
        Clear all
      </button>
    </div>
  {/if}
</div>
