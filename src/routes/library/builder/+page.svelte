<script lang="ts">
	import { page } from '$app/state';
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';

	interface Props {
		data: { cwd: string };
	}

	let { data }: Props = $props();

	const type = $derived(page.url.searchParams.get('type') || 'pipeline');

	const labels: Record<string, string> = {
		pipeline: 'New Pipeline',
		skill: 'New Skill',
		agent: 'New Agent',
	};

	const label = $derived(labels[type] || 'Builder');
</script>

<svelte:head>
	<title>{label} — Soul Hub Builder</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border flex-shrink-0">
		<a href="/library" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to library">
			<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
			</svg>
		</a>
		<h1 class="text-base font-semibold text-hub-text">{label}</h1>
		<span class="text-xs text-hub-dim">Builder Terminal</span>
	</div>

	<!-- Terminal -->
	<div class="flex-1 overflow-hidden">
		<TerminalTabs cwd={data.cwd} projectName="_builder" />
	</div>
</div>
