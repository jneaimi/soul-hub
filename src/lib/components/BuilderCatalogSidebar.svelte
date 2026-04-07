<script lang="ts">
	import type { BlockManifest, BlockType } from '$lib/pipeline/block.js';

	interface Props {
		blocks: BlockManifest[];
		stagedBlockNames?: Set<string>;
		onUseBlock?: (block: BlockManifest) => void;
		onForkBlock?: (block: BlockManifest) => void;
	}

	let { blocks, stagedBlockNames = new Set(), onUseBlock, onForkBlock }: Props = $props();

	let search = $state('');
	let activeFilter = $state<BlockType | 'all'>('all');

	const typeColors: Record<BlockType, string> = {
		script: 'bg-hub-cta/15 text-hub-cta',
		agent: 'bg-hub-purple/15 text-hub-purple',
		skill: 'bg-hub-info/15 text-hub-info',
		mcp: 'bg-hub-warning/15 text-hub-warning',
		pipeline: 'bg-hub-dim/15 text-hub-dim',
	};

	const typeIcons: Record<BlockType, string> = {
		script: 'M4 17l6-6-6-6M12 19h8',
		agent: 'M12 2a10 10 0 110 20 10 10 0 010-20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
		skill: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
		mcp: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
		pipeline: 'M13 17l5-5-5-5M6 17l5-5-5-5',
	};

	const filteredBlocks = $derived.by(() => {
		let result = blocks;
		if (activeFilter !== 'all') {
			result = result.filter((b) => b.type === activeFilter);
		}
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter(
				(b) =>
					b.name.toLowerCase().includes(q) ||
					b.description.toLowerCase().includes(q)
			);
		}
		return result;
	});

	const typeCounts = $derived.by(() => {
		const counts: Record<string, number> = { all: blocks.length };
		for (const b of blocks) {
			counts[b.type] = (counts[b.type] || 0) + 1;
		}
		return counts;
	});
</script>

<div class="flex flex-col h-full bg-hub-surface/50">
	<!-- Header -->
	<div class="flex-shrink-0 px-3 py-2.5 border-b border-hub-border/50">
		<div class="flex items-center gap-2 mb-2">
			<svg class="w-3.5 h-3.5 text-hub-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
			</svg>
			<span class="text-xs font-semibold text-hub-text">Block Catalog</span>
			<span class="text-[10px] text-hub-dim ml-auto">{blocks.length}</span>
		</div>
		<input
			type="text"
			bind:value={search}
			placeholder="Search blocks..."
			class="w-full bg-hub-card border border-hub-border rounded px-2 py-1 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
		/>
	</div>

	<!-- Type filter pills -->
	<div class="flex-shrink-0 flex flex-wrap gap-1 px-3 py-2 border-b border-hub-border/30">
		<button
			onclick={() => (activeFilter = 'all')}
			class="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer
				{activeFilter === 'all' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
		>
			All ({typeCounts.all})
		</button>
		{#each ['script', 'agent', 'skill', 'mcp'] as t}
			{#if typeCounts[t]}
				<button
					onclick={() => (activeFilter = t as BlockType)}
					class="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer
						{activeFilter === t ? typeColors[t as BlockType] : 'text-hub-dim hover:text-hub-muted'}"
				>
					{t}s ({typeCounts[t]})
				</button>
			{/if}
		{/each}
	</div>

	<!-- Block list -->
	<div class="flex-1 overflow-y-auto">
		{#if filteredBlocks.length === 0}
			<div class="flex items-center justify-center py-8">
				<span class="text-xs text-hub-dim">
					{search.trim() ? 'No blocks match' : 'No blocks in catalog'}
				</span>
			</div>
		{:else}
			{#each filteredBlocks as block (block.name)}
				<div class="px-3 py-2.5 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors group">
					<div class="flex items-start gap-2">
						<svg class="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d={typeIcons[block.type] || typeIcons.script}/>
						</svg>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5 mb-0.5">
								<span class="text-xs font-medium text-hub-text truncate">{block.name}</span>
								<span class="text-[9px] px-1 py-0.5 rounded flex-shrink-0 {typeColors[block.type]}">{block.type}</span>
							</div>
							<p class="text-[11px] text-hub-dim leading-snug line-clamp-2">{block.description}</p>

							<!-- Action buttons -->
							<div class="flex items-center gap-1.5 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
								{#if onUseBlock}
									{@const isStaged = stagedBlockNames.has(block.name)}
									<button
										onclick={() => onUseBlock?.(block)}
										class="px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer
											{isStaged ? 'bg-hub-success/15 text-hub-success' : 'bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25'}"
									>
										{isStaged ? 'Added' : 'Add'}
									</button>
								{/if}
								{#if onForkBlock}
									<button
										onclick={() => onForkBlock?.(block)}
										class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-purple/15 text-hub-purple hover:bg-hub-purple/25 transition-colors cursor-pointer"
									>
										Fork
									</button>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
