<script lang="ts">
	import { onMount } from 'svelte';

	interface StatusCounts {
		proposed: number;
		accepted: number;
		shipped: number;
		rejected: number;
		parked: number;
		other: number;
	}

	interface ProjectRollup {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: StatusCounts;
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
		hasIndex: boolean;
	}

	interface QueueRow {
		path: string;
		title: string;
		project: string;
		status: string;
		created: string | null;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
		blockedBy: string[];
	}

	let projects = $state<ProjectRollup[]>([]);
	let queueCount = $state(0);
	let loading = $state(true);
	let error = $state('');
	let filter = $state('');
	let statusFilter = $state<'all' | 'open' | 'shipped' | 'archived'>('all');

	const filtered = $derived(
		projects.filter((p) => {
			if (filter && !p.slug.toLowerCase().includes(filter.toLowerCase())) return false;
			if (statusFilter === 'open' && p.statusCounts.proposed === 0) return false;
			if (statusFilter === 'shipped' && p.statusCounts.shipped === 0) return false;
			if (statusFilter === 'archived' && p.adrCount > 0) return false;
			return true;
		}),
	);

	const totals = $derived.by(() => {
		const t = { adrs: 0, proposed: 0, shipped: 0 };
		for (const p of projects) {
			t.adrs += p.adrCount;
			t.proposed += p.statusCounts.proposed;
			t.shipped += p.statusCounts.shipped;
		}
		return t;
	});

	function timeAgoMs(ms: number | null): string {
		if (!ms) return '—';
		const diff = Date.now() - ms;
		const mins = Math.floor(diff / 60_000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}

	async function loadProjects() {
		error = '';
		try {
			const [projectsRes, queueRes] = await Promise.all([
				fetch('/api/vault/projects'),
				fetch('/api/vault/decisions/queue'),
			]);
			if (!projectsRes.ok) throw new Error(`projects ${projectsRes.status}`);
			if (!queueRes.ok) throw new Error(`queue ${queueRes.status}`);
			const projectsData = await projectsRes.json();
			const queueData = await queueRes.json();
			projects = projectsData.projects ?? [];
			queueCount = (queueData.decisions as QueueRow[] ?? []).length;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	onMount(() => { loadProjects(); });
</script>

<svelte:head>
	<title>Projects | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header + sub-nav -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center justify-between mb-3">
				<div class="flex items-center gap-3">
					<h1 class="text-lg font-semibold text-hub-text">Projects</h1>
					{#if projects.length > 0}
						<span class="text-hub-dim font-normal text-sm">({projects.length})</span>
					{/if}
				</div>
				<div class="flex items-center gap-3 text-xs text-hub-dim">
					<span>{totals.adrs} ADRs</span>
					{#if totals.shipped > 0}
						<span class="text-hub-info">{totals.shipped} shipped</span>
					{/if}
					{#if totals.proposed > 0}
						<a href="/projects/queue" class="px-2 py-1 rounded bg-hub-warning/15 text-hub-warning hover:bg-hub-warning/25 transition-colors cursor-pointer">
							{totals.proposed} awaiting decision
						</a>
					{/if}
				</div>
			</div>
			<nav class="flex items-center gap-1 text-xs">
				<a href="/projects" class="px-3 py-1.5 rounded-md bg-hub-card text-hub-text">
					All
				</a>
				<a href="/projects/queue" class="px-3 py-1.5 rounded-md text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer flex items-center gap-1.5">
					Decision Queue
					{#if queueCount > 0}
						<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-warning/20 text-hub-warning">{queueCount}</span>
					{/if}
				</a>
			</nav>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading projects…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-6 flex items-center justify-between">
					<span>{error}</span>
					<button onclick={() => loadProjects()} class="text-xs underline cursor-pointer">Retry</button>
				</div>
			{:else if projects.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">No projects in vault yet</p>
					<p class="text-hub-dim text-xs">Create a folder under <code class="px-1 py-0.5 rounded bg-hub-card text-hub-text font-mono text-[10px]">~/vault/projects/</code> and add an ADR.</p>
				</div>
			{:else}
				<!-- Filter bar -->
				<div class="flex flex-col sm:flex-row gap-2 mb-4">
					<div class="relative flex-1">
						<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
						</svg>
						<input
							bind:value={filter}
							type="text"
							placeholder="Filter by name…"
							class="w-full bg-transparent border border-hub-border rounded-lg pl-9 pr-3 py-2 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
						/>
					</div>
					<div class="flex items-center gap-1 text-xs">
						<button
							onclick={() => (statusFilter = 'all')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-cta={statusFilter === 'all'}
							class:text-hub-cta={statusFilter === 'all'}
							class:border-hub-border={statusFilter !== 'all'}
							class:text-hub-muted={statusFilter !== 'all'}
						>All</button>
						<button
							onclick={() => (statusFilter = 'open')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-warning={statusFilter === 'open'}
							class:text-hub-warning={statusFilter === 'open'}
							class:border-hub-border={statusFilter !== 'open'}
							class:text-hub-muted={statusFilter !== 'open'}
						>Open</button>
						<button
							onclick={() => (statusFilter = 'shipped')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-info={statusFilter === 'shipped'}
							class:text-hub-info={statusFilter === 'shipped'}
							class:border-hub-border={statusFilter !== 'shipped'}
							class:text-hub-muted={statusFilter !== 'shipped'}
						>Shipped</button>
						<button
							onclick={() => (statusFilter = 'archived')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-dim={statusFilter === 'archived'}
							class:text-hub-dim={statusFilter === 'archived'}
							class:border-hub-border={statusFilter !== 'archived'}
							class:text-hub-muted={statusFilter !== 'archived'}
						>Quiet</button>
					</div>
				</div>

				{#if filtered.length === 0}
					<p class="text-hub-dim text-xs py-6 text-center">No projects match the current filter.</p>
				{:else}
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
						{#each filtered as project}
							<a
								href="/projects/{project.slug}"
								class="group block p-4 rounded-lg border border-hub-border bg-hub-card/40 hover:border-hub-cta/40 hover:bg-hub-card/60 transition-colors cursor-pointer"
							>
								<div class="flex items-start justify-between mb-2 min-w-0">
									<h3 class="text-sm font-semibold text-hub-text group-hover:text-hub-cta transition-colors truncate">
										{project.slug}
									</h3>
									{#if project.upcomingFalsifiers.length > 0}
										<span
											class="ml-2 flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium"
											class:bg-hub-danger={project.upcomingFalsifiers[0].daysAway <= 7}
											class:text-white={project.upcomingFalsifiers[0].daysAway <= 7}
											class:bg-hub-warning={project.upcomingFalsifiers[0].daysAway > 7}
											class:text-black={project.upcomingFalsifiers[0].daysAway > 7}
											title={`Falsifier: ${project.upcomingFalsifiers[0].date}`}
										>
											⏱ {project.upcomingFalsifiers[0].daysAway}d
										</span>
									{/if}
								</div>

								<div class="flex items-center gap-2 text-[11px] mb-3">
									<span class="text-hub-dim">{project.adrCount} ADR{project.adrCount === 1 ? '' : 's'}</span>
									<span class="text-hub-dim">·</span>
									<span class="text-hub-dim">{project.noteCount} note{project.noteCount === 1 ? '' : 's'}</span>
									<span class="text-hub-dim">·</span>
									<span class="text-hub-dim">{timeAgoMs(project.lastActivity)}</span>
								</div>

								<!-- Status pills -->
								<div class="flex flex-wrap items-center gap-1">
									{#if project.statusCounts.proposed > 0}
										<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-warning/15 text-hub-warning">
											{project.statusCounts.proposed} proposed
										</span>
									{/if}
									{#if project.statusCounts.accepted > 0}
										<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-info/15 text-hub-info">
											{project.statusCounts.accepted} accepted
										</span>
									{/if}
									{#if project.statusCounts.shipped > 0}
										<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-cta/15 text-hub-cta">
											{project.statusCounts.shipped} shipped
										</span>
									{/if}
									{#if project.statusCounts.parked > 0}
										<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-dim/15 text-hub-dim">
											{project.statusCounts.parked} parked
										</span>
									{/if}
									{#if project.statusCounts.rejected > 0}
										<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-danger/15 text-hub-danger">
											{project.statusCounts.rejected} rejected
										</span>
									{/if}
									{#if project.adrCount === 0}
										<span class="text-[10px] text-hub-dim">no ADRs yet</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
