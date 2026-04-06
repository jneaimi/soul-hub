<script lang="ts">
	import AgentTerminal from './AgentTerminal.svelte';

	interface Props {
		cwd: string;
		projectName: string;
	}

	interface Tab {
		id: string;
		label: string;
		prompt: string;
		started: boolean;
		ref?: AgentTerminal;
	}

	let { cwd, projectName }: Props = $props();

	let tabs = $state<Tab[]>([]);
	let activeTabId = $state('');
	let promptInput = $state('');
	let nextNum = $state(1);

	function createTab(prompt: string = '', autoStart: boolean = false) {
		const id = crypto.randomUUID().slice(0, 8);
		const label = `Terminal ${nextNum}`;
		nextNum++;
		const tab: Tab = { id, label, prompt, started: autoStart };
		tabs.push(tab);
		activeTabId = id;

		if (autoStart) {
			// Spawn after DOM renders the terminal
			setTimeout(() => {
				const t = tabs.find((t) => t.id === id);
				if (t?.ref) t.ref.spawn(prompt);
			}, 150);
		}
	}

	function closeTab(id: string) {
		const tab = tabs.find((t) => t.id === id);
		if (tab?.ref) {
			tab.ref.kill();
		}
		const idx = tabs.findIndex((t) => t.id === id);
		tabs = tabs.filter((t) => t.id !== id);

		if (activeTabId === id && tabs.length > 0) {
			// Switch to nearest tab
			const newIdx = Math.min(idx, tabs.length - 1);
			activeTabId = tabs[newIdx].id;
		}
	}

	function handleRun() {
		if (!promptInput.trim() && tabs.length === 0) {
			// Open terminal with no prompt
			createTab('', true);
			return;
		}
		if (promptInput.trim()) {
			createTab(promptInput.trim(), true);
			promptInput = '';
		}
	}

	function handleOpen() {
		createTab('', true);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleRun();
		}
	}

	const activeTab = $derived(tabs.find((t) => t.id === activeTabId));
</script>

<div class="flex flex-col h-full">
	<!-- Tab bar + prompt (when no tabs or adding new) -->
	{#if tabs.length > 0}
		<div class="flex-shrink-0 flex items-center bg-[#0a0a0f] border-b border-hub-border/50 overflow-x-auto">
			{#each tabs as tab (tab.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					onclick={() => activeTabId = tab.id}
					class="group flex items-center gap-1.5 px-3 py-2 text-xs border-r border-hub-border/30 whitespace-nowrap transition-colors cursor-pointer select-none
						{tab.id === activeTabId ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="w-1.5 h-1.5 rounded-full {tab.id === activeTabId ? 'bg-hub-cta' : 'bg-hub-dim/50'}"></span>
					{tab.label}
					<button
						onclick={(e: MouseEvent) => { e.stopPropagation(); closeTab(tab.id); }}
						class="ml-1 p-0.5 rounded hover:bg-hub-danger/20 hover:text-hub-danger transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
						title="Close terminal"
					>
						<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
						</svg>
					</button>
				</div>
			{/each}
			<button
				onclick={() => handleOpen()}
				class="px-3 py-2 text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50 transition-colors cursor-pointer"
				title="New terminal"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
			</button>
		</div>
	{/if}

	<!-- Terminal area -->
	{#if tabs.length === 0}
		<!-- No terminals yet — show prompt -->
		<div class="flex-1 flex flex-col">
			<div class="px-4 sm:px-6 py-4 border-b border-hub-border bg-hub-surface/50">
				<div class="space-y-3">
					<div>
						<div class="flex items-center justify-between mb-1">
							<label for="prompt-input" class="text-[10px] text-hub-dim uppercase tracking-wider">Prompt</label>
							<span class="text-[10px] text-hub-dim">Shift+Enter for new line</span>
						</div>
						<textarea
							id="prompt-input"
							bind:value={promptInput}
							onkeydown={handleKeydown}
							placeholder="What should the agent do?"
							rows="3"
							class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-dim resize-none focus:outline-none focus:border-hub-cta/50"
						></textarea>
					</div>
					<div class="flex items-center gap-2">
						<button
							onclick={handleRun}
							disabled={!promptInput.trim()}
							class="px-6 py-2.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
						>
							Run Agent
						</button>
						<button
							onclick={handleOpen}
							class="px-6 py-2.5 rounded-lg bg-hub-card border border-hub-border text-hub-text font-medium text-sm hover:bg-hub-surface hover:border-hub-dim transition-colors cursor-pointer"
						>
							Open Terminal
						</button>
					</div>
				</div>
			</div>
			<div class="flex-1 flex items-center justify-center">
				<div class="text-center">
					<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
					</svg>
					<p class="text-sm text-hub-dim">Enter a prompt or open a terminal to start</p>
				</div>
			</div>
		</div>
	{:else}
		<!-- Active terminal -->
		{#each tabs as tab (tab.id)}
			<div class="flex-1 min-h-0 {tab.id === activeTabId ? '' : 'hidden'}">
				<AgentTerminal
					bind:this={tab.ref}
					cwd={cwd}
					prompt={tab.prompt}
					{projectName}
				/>
			</div>
		{/each}
	{/if}
</div>
