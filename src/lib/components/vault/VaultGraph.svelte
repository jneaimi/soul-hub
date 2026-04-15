<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { GraphNode, GraphEdge } from '$lib/vault/types';

  interface Props {
    nodes: GraphNode[];
    edges: GraphEdge[];
    onNodeClick: (path: string) => void;
  }

  let { nodes, edges, onNodeClick }: Props = $props();

  let container: HTMLDivElement;
  let renderer: InstanceType<typeof import('sigma').default> | null = null;
  let mounted = false;

  let GraphClass: typeof import('graphology').default;
  let SigmaClass: typeof import('sigma').default;
  let EdgeProg: unknown;

  let hoveredNode = $state<string | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipLabel = $state('');
  let tooltipType = $state('');
  let tooltipDegree = $state(0);
  let tooltipNew = $state(false);
  let showRanking = $state(true);
  let rankingTab = $state<'latest' | 'connected'>('latest');

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const NEW_ACCENT = '#22d3ee'; // cyan-400 — accent ring for new nodes

  /** Check if a note was CREATED (not just modified) within the last 7 days */
  function isNew(created: string | undefined): boolean {
    if (!created) return false;
    const createdMs = new Date(created).getTime();
    if (isNaN(createdMs)) return false;
    return Date.now() - createdMs < SEVEN_DAYS_MS;
  }

  function daysAgo(created: string): string {
    const diff = Date.now() - new Date(created).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return '1d ago';
    return `${days}d ago`;
  }

  // Top nodes by degree
  const topConnected = $derived(
    [...nodes]
      .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
      .slice(0, 7)
      .filter((n) => (n.degree ?? 0) > 0)
  );

  // Latest nodes by created date
  const latestNodes = $derived(
    [...nodes]
      .filter((n) => n.created)
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      .slice(0, 7)
  );

  const newCount = $derived(
    nodes.filter((n) => isNew(n.created)).length
  );

  const rankingNodes = $derived(rankingTab === 'connected' ? topConnected : latestNodes);

  function buildGraph() {
    if (renderer) {
      renderer.kill();
      renderer = null;
    }
    if (!GraphClass || !SigmaClass || !container || nodes.length === 0) return;

    const graph = new GraphClass();

    for (const node of nodes) {
      const nodeIsNew = isNew(node.created);
      graph.addNode(node.id, {
        label: node.label,
        // New nodes get a size bump (+3) so they stand out
        size: nodeIsNew ? node.size + 3 : node.size,
        // KEEP the zone/type color — don't override
        color: node.color,
        x: Math.random() * 100,
        y: Math.random() * 100,
        nodeType: node.type || '',
        degree: node.degree ?? 0,
        isNew: nodeIsNew,
      });
    }

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        try {
          graph.addEdge(edge.source, edge.target, {
            color: '#7c8cf844',
            size: 1,
          });
        } catch {
          // parallel edge — skip
        }
      }
    }

    const settings: Record<string, unknown> = {
      renderEdgeLabels: false,
      labelColor: { color: '#e2e8f0' },
      labelFont: 'IBM Plex Sans',
      labelSize: 11,
      // New nodes always show their label regardless of density
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.07,
      labelGridCellSize: 150,
      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#7c8cf844',
      defaultEdgeType: 'rectangle',
      minEdgeThickness: 0.5,
    };

    if (EdgeProg) {
      settings.edgeProgramClasses = { rectangle: EdgeProg };
    }

    renderer = new SigmaClass(graph, container, settings as ConstructorParameters<typeof SigmaClass>[2]);

    renderer.on('enterNode', ({ node }) => {
      hoveredNode = node;
      const attrs = graph.getNodeAttributes(node);
      tooltipLabel = (attrs.label as string) || node;
      tooltipType = (attrs.nodeType as string) || '';
      tooltipDegree = (attrs.degree as number) || 0;
      tooltipNew = (attrs.isNew as boolean) || false;
      container.style.cursor = 'pointer';

      const neighbors = new Set(graph.neighbors(node));
      neighbors.add(node);
      renderer!.setSetting('nodeReducer', (n: string, data: Record<string, unknown>) => {
        if (neighbors.has(n)) return { ...data, zIndex: 1 };
        return { ...data, color: '#333333', label: '' };
      });
      renderer!.setSetting('edgeReducer', (edge: string, data: Record<string, unknown>) => {
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        if (neighbors.has(src) && neighbors.has(tgt)) {
          return { ...data, color: '#7c8cf8cc', size: 2 };
        }
        return { ...data, color: '#ffffff08' };
      });
    });

    renderer.on('leaveNode', () => {
      hoveredNode = null;
      container.style.cursor = 'default';
      renderer!.setSetting('nodeReducer', null);
      renderer!.setSetting('edgeReducer', null);
    });

    renderer.on('clickNode', ({ node }) => {
      onNodeClick(node);
    });

    renderer.getMouseCaptor().on('mousemove', (e: { x: number; y: number }) => {
      if (hoveredNode) {
        tooltipX = e.x;
        tooltipY = e.y;
      }
    });

    import('graphology-layout-forceatlas2').then(({ default: forceAtlas2 }) => {
      if (!graph || graph.order === 0) return;
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: {
          gravity: 0.1,
          scalingRatio: 20,
          strongGravityMode: true,
          barnesHutOptimize: false,
          slowDown: 6,
        }
      });
      renderer?.refresh();
    }).catch(() => {});
  }

  function focusNode(nodeId: string) {
    if (!renderer) return;
    const cam = renderer.getCamera();
    const pos = renderer.getNodeDisplayData(nodeId);
    if (pos) {
      cam.animate({ x: pos.x, y: pos.y, ratio: 0.3 }, { duration: 400 });
    }
  }

  $effect(() => {
    const _n = nodes;
    const _e = edges;
    if (mounted) buildGraph();
  });

  onMount(async () => {
    const [graphMod, sigmaMod, renderMod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('sigma/rendering'),
    ]);
    GraphClass = graphMod.default;
    SigmaClass = sigmaMod.default;
    EdgeProg = renderMod.EdgeRectangleProgram;
    mounted = true;
    buildGraph();
  });

  onDestroy(() => {
    if (renderer) {
      renderer.kill();
      renderer = null;
    }
  });
</script>

<div class="relative w-full h-full">
  <div bind:this={container} class="w-full h-full"></div>

  {#if hoveredNode}
    <div
      class="absolute pointer-events-none bg-hub-card border border-hub-border rounded-lg px-3 py-2 shadow-lg z-10"
      style="left: {tooltipX + 12}px; top: {tooltipY - 10}px;"
    >
      <p class="text-sm text-hub-text font-medium">{tooltipLabel}</p>
      <div class="flex items-center gap-2 mt-0.5">
        {#if tooltipType}
          <span class="text-xs text-hub-muted">{tooltipType}</span>
        {/if}
        <span class="text-xs text-hub-dim">{tooltipDegree} connections</span>
        {#if tooltipNew}
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 font-medium">new</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if nodes.length === 0}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="text-center">
        <svg class="w-12 h-12 mx-auto text-hub-dim mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/>
        </svg>
        <p class="text-hub-dim text-sm">No notes in the vault yet</p>
        <p class="text-hub-dim/60 text-xs mt-1">Create a note to see the knowledge graph</p>
      </div>
    </div>
  {/if}

  {#if nodes.length > 0}
    <!-- Top right: stats -->
    <div class="absolute top-3 right-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-1.5 flex items-center gap-3">
      <span class="text-xs text-hub-muted">{nodes.length} nodes · {edges.length} edges</span>
      {#if newCount > 0}
        <span class="text-[10px] text-cyan-400">{newCount} new</span>
      {/if}
      <button
        onclick={() => { showRanking = !showRanking; }}
        class="text-[10px] text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
      >
        {showRanking ? 'Hide' : 'Show'} panel
      </button>
    </div>

    <!-- Ranking panel with tabs -->
    {#if showRanking && rankingNodes.length > 0}
      <div class="absolute top-12 right-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg w-60 max-h-72 overflow-hidden flex flex-col">
        <div class="flex border-b border-hub-border/50">
          <button
            onclick={() => { rankingTab = 'latest'; }}
            class="flex-1 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider cursor-pointer transition-colors
              {rankingTab === 'latest' ? 'text-cyan-400 border-b border-cyan-400' : 'text-hub-dim hover:text-hub-muted'}"
          >
            Latest
          </button>
          <button
            onclick={() => { rankingTab = 'connected'; }}
            class="flex-1 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider cursor-pointer transition-colors
              {rankingTab === 'connected' ? 'text-hub-cta border-b border-hub-cta' : 'text-hub-dim hover:text-hub-muted'}"
          >
            Most connected
          </button>
        </div>

        <div class="overflow-y-auto px-3 py-1.5">
          {#each rankingNodes as node, i (node.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              onclick={() => { focusNode(node.id); onNodeClick(node.id); }}
              class="flex items-center gap-2 py-1.5 px-1 -mx-1 rounded hover:bg-hub-surface transition-colors cursor-pointer group"
            >
              <span class="text-[10px] text-hub-dim w-3 text-right font-mono flex-shrink-0">{i + 1}</span>
              <span
                class="flex-shrink-0 w-2.5 h-2.5 rounded-full"
                style="background-color: {node.color}"
              ></span>
              <div class="flex-1 min-w-0">
                <span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate block">{node.label}</span>
                {#if rankingTab === 'latest' && node.created}
                  <span class="text-[10px] text-hub-dim">{daysAgo(node.created)}</span>
                {/if}
              </div>
              {#if rankingTab === 'connected'}
                <span class="text-[10px] text-hub-dim font-mono flex-shrink-0">{node.degree}</span>
              {/if}
              {#if isNew(node.created)}
                <span class="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Bottom left: legend -->
    <div class="absolute bottom-3 left-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-2">
      <div class="flex flex-wrap gap-x-3 gap-y-1">
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #6366f1"></span> projects
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #06b6d4"></span> knowledge
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #8b5cf6"></span> content
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #64748b"></span> operations
        </span>
      </div>
      <p class="text-[10px] text-hub-dim/60 mt-1">Larger nodes = more connections. New notes (7d) are bigger in the graph.</p>
    </div>
  {/if}
</div>
