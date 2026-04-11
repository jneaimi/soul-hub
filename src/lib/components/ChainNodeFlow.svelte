<script lang="ts">
	interface ChainNode {
		id: string;
		pipeline: string;
		inputs?: Record<string, string>;
		depends_on?: string[];
		when?: string;
	}

	interface NodeDetail {
		id: string;
		pipeline: string;
		description: string;
		stepCount: number;
		inputs?: { name: string; type: string; description: string }[];
	}

	interface StepRun {
		id: string;
		status: string;
	}

	interface PipelineRun {
		steps: StepRun[];
	}

	interface NodeRun {
		id: string;
		status: string;
		durationMs?: number;
		error?: string;
		pipelineRun?: PipelineRun;
	}

	interface ChainRun {
		nodes: NodeRun[];
	}

	interface Props {
		nodes: ChainNode[];
		nodeDetails: NodeDetail[];
		activeRun?: ChainRun | null;
		onRetryNode?: (nodeId: string) => void;
		onTroubleshoot?: (nodeId: string, error: string) => void;
	}

	const { nodes, nodeDetails, activeRun = null, onRetryNode, onTroubleshoot }: Props = $props();

	const statusIcon: Record<string, string> = {
		pending: '○', running: '◉', done: '✓', failed: '✗', skipped: '–', waiting: '◎',
	};
	const statusColor: Record<string, string> = {
		waiting: 'text-hub-warning',
		pending: 'text-hub-dim',
		running: 'text-hub-info',
		done: 'text-hub-cta',
		failed: 'text-hub-danger',
		skipped: 'text-hub-dim',
	};

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function computeLevels(nodes: ChainNode[]): string[][] {
		const levels: string[][] = [];
		const placed = new Set<string>();

		while (placed.size < nodes.length) {
			const level: string[] = [];
			for (const node of nodes) {
				if (placed.has(node.id)) continue;
				const deps = node.depends_on || [];
				if (deps.every(d => placed.has(d))) level.push(node.id);
			}
			if (level.length === 0) break;
			for (const id of level) placed.add(id);
			levels.push(level);
		}
		return levels;
	}

	const levels = $derived(computeLevels(nodes));
</script>

{#if nodes.length === 0}
	<div class="text-center py-8 text-hub-dim text-sm">No nodes defined in this chain</div>
{:else}
	<div class="flex flex-col items-center gap-2">
		{#each levels as level, levelIdx}
			{#if levelIdx > 0}
				<div class="flex items-center justify-center gap-8">
					{#each level as _nodeId}
						<div class="w-px h-6 bg-hub-border"></div>
					{/each}
				</div>
			{/if}

			<div class="flex flex-wrap gap-3 justify-center w-full">
				{#each level as nodeId}
					{@const node = nodes.find(n => n.id === nodeId)}
					{@const detail = nodeDetails.find(d => d.id === nodeId)}
					{@const nodeRun = activeRun?.nodes.find(n => n.id === nodeId)}
					{@const status = nodeRun?.status || 'pending'}

					{#if node}
						<div class="flex-1 min-w-[200px] max-w-[400px] rounded-lg border overflow-hidden transition-colors
							{status === 'running' ? 'border-hub-info/40 bg-hub-info/5' :
							 status === 'done' ? 'border-hub-cta/20 bg-hub-surface' :
							 status === 'failed' ? 'border-hub-danger/30 bg-hub-danger/5' :
							 status === 'skipped' ? 'border-hub-border/30 bg-hub-surface opacity-50' :
							 'border-hub-border/50 bg-hub-surface'}">

							<div class="px-4 py-3">
								<div class="flex items-center gap-2 mb-1">
									<span class="text-base {statusColor[status]} {status === 'running' ? 'animate-pulse' : ''}">
										{statusIcon[status]}
									</span>
									<span class="font-medium text-sm text-hub-text">{node.id}</span>
									{#if level.length > 1}
										<span class="px-1 py-0.5 rounded text-[8px] font-medium bg-hub-purple/10 text-hub-purple">parallel</span>
									{/if}
								</div>
								<div class="flex items-center gap-2 ml-6">
									<span class="text-xs text-hub-muted">&rarr; {node.pipeline}</span>
									{#if detail?.stepCount}
										<span class="text-[10px] text-hub-dim">{detail.stepCount} steps</span>
									{/if}
								</div>
								{#if node.when}
									<div class="ml-6 mt-1 text-[10px] text-hub-dim italic">when: {node.when}</div>
								{/if}
							</div>

							{#if nodeRun?.pipelineRun && (status === 'running' || status === 'done' || status === 'failed')}
								<div class="border-t border-hub-border/30 px-4 py-2">
									<div class="flex items-center gap-1.5 flex-wrap">
										{#each nodeRun.pipelineRun.steps as step}
											<div class="flex items-center gap-1 text-[10px]
												{step.status === 'done' ? 'text-hub-cta' :
												 step.status === 'running' ? 'text-hub-info' :
												 step.status === 'failed' ? 'text-hub-danger' :
												 'text-hub-dim'}">
												<span>{statusIcon[step.status]}</span>
												<span>{step.id}</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							{#if status === 'failed'}
								<div class="border-t border-hub-danger/20 px-4 py-2 flex items-center gap-2">
									<button onclick={() => onRetryNode?.(node.id)}
										class="inline-flex items-center gap-1 border border-hub-cta/30 text-hub-cta hover:bg-hub-cta/10 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer">
										Retry
									</button>
									<button onclick={() => onTroubleshoot?.(node.id, nodeRun?.error || '')}
										class="inline-flex items-center gap-1 border border-red-500/30 text-red-400 hover:bg-red-500/10 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer">
										Troubleshoot
									</button>
								</div>
							{/if}

							{#if nodeRun?.durationMs}
								<div class="px-4 py-1 text-[10px] text-hub-dim border-t border-hub-border/20">
									{formatDuration(nodeRun.durationMs)}
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			</div>
		{/each}
	</div>
{/if}
