<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';

	interface DecisionRow {
		path: string;
		title: string;
		status: string;
		created: string | null;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
	}

	interface ProjectDetail {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: { proposed: number; accepted: number; shipped: number; rejected: number; parked: number; other: number };
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number }[];
		hasIndex: boolean;
	}

	let detail = $state<ProjectDetail | null>(null);
	let decisions = $state<DecisionRow[]>([]);
	let loading = $state(true);
	let error = $state('');

	const slug = $derived($page.params.slug);

	async function load() {
		error = '';
		loading = true;
		try {
			const [projectRes, notesRes] = await Promise.all([
				fetch(`/api/vault/projects?slug=${encodeURIComponent(slug)}`),
				fetch(`/api/vault/notes?project=${encodeURIComponent(slug)}&type=decision&limit=200`),
			]);
			if (!projectRes.ok) throw new Error(`Project load: ${projectRes.status}`);
			const projectData = await projectRes.json();
			detail = (projectData.projects ?? [])[0] ?? null;

			if (!notesRes.ok) throw new Error(`Notes load: ${notesRes.status}`);
			const notesData = await notesRes.json();
			// Flatten + enrich for the table — falsifier metadata lives in full note,
			// but the search result has enough for a list view. The /api/vault/projects
			// endpoint already surfaces the upcoming falsifier list separately.
			decisions = (notesData.results ?? []).map((r: { path: string; title: string; tags?: string[] }) => ({
				path: r.path,
				title: r.title || r.path.split('/').pop()?.replace(/\.md$/, '') || r.path,
				status: '',
				created: null,
				falsifierDate: null,
				falsifierDaysAway: null,
				tags: r.tags ?? [],
			}));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Load failed';
		} finally {
			loading = false;
		}
	}

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

	$effect(() => { if (slug) load(); });
</script>

<svelte:head>
	<title>{slug} | Projects | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center gap-3 mb-2">
				<a href="/projects" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text" aria-label="Back to projects">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
					</svg>
				</a>
				<h1 class="text-lg font-semibold text-hub-text truncate">{slug}</h1>
				{#if detail}
					<span class="text-hub-dim text-sm">{detail.adrCount} ADR{detail.adrCount === 1 ? '' : 's'} · {detail.noteCount} note{detail.noteCount === 1 ? '' : 's'}</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{:else if !detail}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">Project not found in vault</p>
					<p class="text-hub-dim text-xs">No folder at <code class="font-mono">~/vault/projects/{slug}/</code>.</p>
				</div>
			{:else}
				<!-- Stat cards -->
				<div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-6">
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Proposed</div>
						<div class="text-lg font-semibold text-hub-warning">{detail.statusCounts.proposed}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Accepted</div>
						<div class="text-lg font-semibold text-hub-info">{detail.statusCounts.accepted}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Shipped</div>
						<div class="text-lg font-semibold text-hub-cta">{detail.statusCounts.shipped}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Parked</div>
						<div class="text-lg font-semibold text-hub-dim">{detail.statusCounts.parked}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Last activity</div>
						<div class="text-sm font-medium text-hub-text">{timeAgoMs(detail.lastActivity)}</div>
					</div>
				</div>

				<!-- Falsifier alerts -->
				{#if detail.upcomingFalsifiers.length > 0}
					<div class="mb-6 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="text-xs font-medium text-hub-warning mb-2">Upcoming falsifier dates</div>
						<div class="space-y-1">
							{#each detail.upcomingFalsifiers as f}
								<div class="flex items-center justify-between text-xs">
									<span class="font-mono text-hub-text truncate">{f.path.split('/').pop()}</span>
									<span class="text-hub-warning ml-2">⏱ {f.daysAway}d ({f.date})</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Decisions list -->
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-sm font-semibold text-hub-text">Decisions ({decisions.length})</h2>
					<a href="/projects/queue" class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer">View queue →</a>
				</div>

				{#if decisions.length === 0}
					<p class="text-hub-dim text-xs py-6 text-center">No decisions yet for this project.</p>
				{:else}
					<div class="divide-y divide-hub-border/60 border border-hub-border rounded-lg bg-hub-card/40">
						{#each decisions as d}
							<div class="px-4 py-3 hover:bg-hub-card/60 transition-colors">
								<div class="flex items-center gap-2 min-w-0">
									<span class="text-sm font-medium text-hub-text truncate flex-1">
										{d.title}
									</span>
									{#if d.tags.length > 0}
										<div class="flex items-center gap-1 flex-shrink-0">
											{#each d.tags.slice(0, 3) as tag}
												<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
											{/each}
										</div>
									{/if}
								</div>
								<div class="text-[11px] text-hub-dim font-mono truncate mt-0.5">{d.path}</div>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
