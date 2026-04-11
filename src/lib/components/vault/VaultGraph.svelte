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

  function buildGraph() {
    if (renderer) {
      renderer.kill();
      renderer = null;
    }
    if (!GraphClass || !SigmaClass || !container || nodes.length === 0) return;

    const graph = new GraphClass();

    for (const node of nodes) {
      graph.addNode(node.id, {
        label: node.label,
        size: node.size, // pre-computed 4–18 range from graph.ts
        color: node.color,
        x: Math.random() * 100,
        y: Math.random() * 100,
        nodeType: node.type || '',
      });
    }

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        try {
          graph.addEdge(edge.source, edge.target, {
            color: '#7c8cf844', // indigo at ~27% opacity — subtle on dark bg
            size: 1,
          });
        } catch {
          // parallel edge — skip
        }
      }
    }

    // Sigma settings — researched from official docs + community best practices
    const settings: Record<string, unknown> = {
      renderEdgeLabels: false,
      labelColor: { color: '#e2e8f0' },
      labelFont: 'IBM Plex Sans',
      labelSize: 11,
      labelRenderedSizeThreshold: 8,   // only show labels on nodes >= 8px
      labelDensity: 0.07,              // ~1 label per grid cell
      labelGridCellSize: 150,          // larger cells = less clutter
      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#7c8cf844',
      defaultEdgeType: 'rectangle',
      minEdgeThickness: 0.5,
    };

    if (EdgeProg) {
      settings.edgeProgramClasses = { rectangle: EdgeProg };
    }

    renderer = new SigmaClass(graph, container, settings as ConstructorParameters<typeof SigmaClass>[2]);

    // Hover: highlight node + show tooltip
    renderer.on('enterNode', ({ node }) => {
      hoveredNode = node;
      const attrs = graph.getNodeAttributes(node);
      tooltipLabel = (attrs.label as string) || node;
      tooltipType = (attrs.nodeType as string) || '';
      container.style.cursor = 'pointer';

      // Highlight neighbors, fade others (Obsidian-like)
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
          return { ...data, color: '#7c8cf8cc', size: 2 }; // bright on hover
        }
        return { ...data, color: '#ffffff08' }; // near invisible
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

    // ForceAtlas2 layout — settings tuned for ~150 nodes
    import('graphology-layout-forceatlas2').then(({ default: forceAtlas2 }) => {
      if (!graph || graph.order === 0) return;
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: {
          gravity: 0.1,
          scalingRatio: 20,       // more spread, fewer overlaps
          strongGravityMode: true,
          barnesHutOptimize: false,
          slowDown: 6,
        }
      });
      renderer?.refresh();
    }).catch(() => {});
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
      {#if tooltipType}
        <p class="text-xs text-hub-muted">{tooltipType}</p>
      {/if}
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
    <div class="absolute bottom-3 left-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-2">
      <p class="text-xs text-hub-dim mb-1.5 font-medium">Zones</p>
      <div class="flex flex-wrap gap-2">
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #6366f1"></span> projects
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #8b5cf6"></span> patterns
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #06b6d4"></span> research
        </span>
        <span class="flex items-center gap-1 text-xs text-hub-muted">
          <span class="w-2.5 h-2.5 rounded-full" style="background: #f59e0b"></span> inbox
        </span>
      </div>
    </div>

    <div class="absolute top-3 right-3 bg-hub-card/90 backdrop-blur-sm border border-hub-border rounded-lg px-3 py-1.5">
      <span class="text-xs text-hub-muted">{nodes.length} nodes · {edges.length} edges</span>
    </div>
  {/if}
</div>
