<script lang="ts">
	import { page } from '$app/state';
	import AgentTerminal from '$lib/components/AgentTerminal.svelte';

	const projectName = $derived(page.params.name);
	const devPath = $derived(`${import.meta.env.SSR ? '' : ''}` || `/Users/${typeof window !== 'undefined' ? '' : ''}`) ;

	let prompt = $state('');
	let terminalRef: AgentTerminal | undefined = $state();
	let started = $state(false);

	function handleRun() {
		if (!prompt.trim()) return;
		started = true;
		setTimeout(() => {
			terminalRef?.spawn(prompt);
		}, 100);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && prompt.trim()) {
			e.preventDefault();
			handleRun();
		}
	}
</script>

<svelte:head>
	<title>{projectName} — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Project Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border bg-hub-surface/50">
		<div class="flex items-center gap-3 mb-4">
			<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div>
				<h1 class="text-lg font-bold text-hub-text">{projectName}</h1>
				<p class="text-xs text-hub-dim">~/dev/{projectName}</p>
			</div>
		</div>

		{#if !started}
			<div class="space-y-3">
				<div>
					<label class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Prompt</label>
					<textarea
						bind:value={prompt}
						onkeydown={handleKeydown}
						placeholder="What should the agent do?"
						rows="3"
						class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-dim resize-none focus:outline-none focus:border-hub-cta/50"
					></textarea>
				</div>

				<button
					onclick={handleRun}
					disabled={!prompt.trim()}
					class="px-6 py-2.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
				>
					Run Agent
				</button>
			</div>
		{/if}
	</header>

	<!-- Terminal -->
	{#if started}
		<div class="flex-1 min-h-0">
			<AgentTerminal
				bind:this={terminalRef}
				cwd={`/Users/jneaimi/dev/${projectName}`}
				{prompt}
			/>
		</div>
	{:else}
		<div class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
				<p class="text-sm text-hub-dim">Enter a prompt to start a live agent session</p>
			</div>
		</div>
	{/if}
</div>
