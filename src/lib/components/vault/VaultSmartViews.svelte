<script lang="ts">
  interface SmartView {
    name: string;
    icon: string;
    filters: { zone?: string; type?: string[]; tags?: string[] };
  }

  interface Props {
    activeFilters: { zone?: string; type?: string | string[]; tags?: string[] };
    onApply: (filters: { zone?: string; type?: string[]; tags?: string[] }) => void;
  }

  let { activeFilters, onApply }: Props = $props();

  const defaultViews: SmartView[] = [
    { name: 'All', icon: 'M4 6h16M4 12h16M4 18h16', filters: {} },
    { name: 'Signal Forge', icon: 'M13 10V3L4 14h7v7l9-11h-7z', filters: { tags: ['signal-forge'] } },
    { name: 'Recipes', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', filters: { zone: 'knowledge', type: ['recipe'] } },
    { name: 'Drafts', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z', filters: { zone: 'content', type: ['draft', 'social-draft', 'article-draft'] } },
    { name: 'Research', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z', filters: { zone: 'knowledge', type: ['research', 'report', 'analysis'] } },
    { name: 'Agents', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', filters: { zone: 'operations', type: ['agent-profile', 'config'] } },
    { name: 'This Week', icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', filters: {} },
  ];

  function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  function isActive(view: SmartView): boolean {
    const f = activeFilters;
    const vf = view.filters;

    // Normalize active type to array
    const activeType = f.type ? (Array.isArray(f.type) ? f.type : [f.type]) : undefined;
    const viewType = vf.type && vf.type.length > 0 ? vf.type : undefined;

    const activeTags = f.tags && f.tags.length > 0 ? f.tags : undefined;
    const viewTags = vf.tags && vf.tags.length > 0 ? vf.tags : undefined;

    return (f.zone ?? undefined) === (vf.zone ?? undefined)
      && arraysEqual(activeType, viewType)
      && arraysEqual(activeTags, viewTags);
  }
</script>

<div class="flex items-center gap-1.5 px-4 py-2 border-b border-hub-border bg-hub-bg/50 overflow-x-auto scrollbar-thin">
  {#each defaultViews as view}
    <button
      class="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer
        {isActive(view) ? 'bg-hub-cta/15 text-hub-cta border border-hub-cta/30' : 'text-hub-muted hover:text-hub-text hover:bg-hub-card border border-transparent'}
        focus:ring-2 focus:ring-blue-500 focus:outline-none"
      onclick={() => onApply(view.filters)}
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={view.icon} />
      </svg>
      {view.name}
    </button>
  {/each}
</div>
