<script lang="ts">
	import type { BlockManifest, BlockType } from '$lib/pipeline/block.js';

	interface Props {
		blocks: BlockManifest[];
		stagedBlockNames?: Set<string>;
		onReference: (block: BlockManifest) => void;
	}

	let { blocks, stagedBlockNames = new Set(), onReference }: Props = $props();

	let search = $state('');

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

	// Group order and default expansion
	const groupOrder: BlockType[] = ['script', 'agent', 'skill', 'mcp'];
	const groupLabels: Record<BlockType, string> = {
		script: 'Scripts',
		agent: 'Agents',
		skill: 'Skills',
		mcp: 'MCPs',
		pipeline: 'Pipelines',
	};

	// Scripts + Agents expanded by default; Skills + MCPs collapsed
	let collapsed = $state<Record<string, boolean>>({
		script: false,
		agent: false,
		skill: true,
		mcp: true,
		pipeline: true,
	});

	function toggleGroup(type: string) {
		collapsed[type] = !collapsed[type];
	}

	// Search-filtered blocks
	const filteredBlocks = $derived.by(() => {
		if (!search.trim()) return blocks;
		const q = search.toLowerCase();
		return blocks.filter(
			(b) =>
				b.name.toLowerCase().includes(q) ||
				b.description.toLowerCase().includes(q)
		);
	});

	// Grouped blocks
	const grouped = $derived.by(() => {
		const groups: Record<string, BlockManifest[]> = {};
		for (const b of filteredBlocks) {
			if (!groups[b.type]) groups[b.type] = [];
			groups[b.type].push(b);
		}
		return groups;
	});

	// When searching, expand all groups
	const isSearching = $derived(search.trim().length > 0);
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

	<!-- Grouped block list -->
	<div class="flex-1 overflow-y-auto">
		{#if filteredBlocks.length === 0}
			<div class="flex items-center justify-center py-8">
				<span class="text-xs text-hub-dim">
					{search.trim() ? 'No blocks match' : 'No blocks in catalog'}
				</span>
			</div>
		{:else}
			{#each groupOrder as type (type)}
				{@const items = grouped[type]}
				{#if items && items.length > 0}
					{@const isCollapsed = !isSearching && collapsed[type]}
					<!-- Group header -->
					<button
						onclick={() => toggleGroup(type)}
						class="w-full flex items-center gap-2 px-3 py-2 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors cursor-pointer select-none"
					>
						<svg
							class="w-3 h-3 text-hub-dim transition-transform {isCollapsed ? '-rotate-90' : ''}"
							viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						>
							<polyline points="6 9 12 15 18 9"/>
						</svg>
						<span class="text-[11px] font-semibold text-hub-muted uppercase tracking-wider">{groupLabels[type]}</span>
						<span class="text-[10px] text-hub-dim ml-auto">{items.length}</span>
					</button>

					<!-- Group items -->
					{#if !isCollapsed}
						{#each items as block (block.name)}
							<div class="px-3 py-2.5 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors group pl-6">
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

										<!-- Reference button -->
										{#if stagedBlockNames.has(block.name)}
											<button
												onclick={() => onReference(block)}
												class="mt-1.5 px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer bg-hub-cta/15 text-hub-cta"
											>
												+ Referenced
											</button>
										{:else}
											<button
												onclick={() => onReference(block)}
												class="mt-1.5 px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer bg-hub-card text-hub-muted hover:bg-hub-cta/10 hover:text-hub-cta"
											>
												+ Reference
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					{/if}
				{/if}
			{/each}
		{/if}
	</div>
</div>
