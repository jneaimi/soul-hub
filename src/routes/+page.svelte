<script lang="ts">
	import { onMount } from 'svelte';
	import SystemNotifications from '$lib/components/SystemNotifications.svelte';

	interface DashboardData {
		pipelineSummary: { total: number; items: { name: string; type: 'pipeline' | 'chain' }[] };
	}

	interface VaultRecent {
		path: string;
		title: string;
		meta: { type?: string; [key: string]: unknown };
		mtime: number;
	}

	let dashboard = $state<DashboardData | null>(null);

	// Playbooks
	interface PlaybookSummary {
		name: string;
		description: string;
		roles: { id: string; provider: string }[];
		phases: { id: string; type: string }[];
	}
	let playbookCount = $state(0);
	let playbookItems = $state<PlaybookSummary[]>([]);
	let playbookProviders = $state<Record<string, boolean>>({});

	// Vault
	let vaultNoteCount = $state(0);
	let vaultRecent = $state<VaultRecent[]>([]);
	let vaultOrphans = $state(0);
	let vaultUnresolved = $state(0);
	let vaultZones = $state<Record<string, number>>({});
	let vaultThisWeek = $state(0);

	// Files Explorer roots
	interface ExplorerRoot {
		id: string;
		name: string;
		path: string;
		resolvedPath: string;
	}
	let explorerRoots = $state<ExplorerRoot[]>([]);

	// Scheduler tile data
	interface SchedulerTaskSummary {
		id: string;
		type: string;
		enabled: boolean;
		lastStatus: string | null;
		nextRunAt: string | null;
	}
	let schedulerTasks = $state<SchedulerTaskSummary[]>([]);

	const noteTypeColors: Record<string, string> = {
		learning: '#10b981',
		decision: '#f59e0b',
		debugging: '#ef4444',
		pattern: '#8b5cf6',
		research: '#06b6d4',
		output: '#3b82f6',
	};

	async function loadDashboard() {
		try {
			const res = await fetch('/api/dashboard');
			if (res.ok) dashboard = await res.json();
		} catch { /* silent */ }
	}

	async function loadScheduler() {
		try {
			const res = await fetch('/api/scheduler/tasks?historyLimit=1');
			if (res.ok) {
				const data = await res.json();
				schedulerTasks = (data.tasks ?? []).map((t: SchedulerTaskSummary) => ({
					id: t.id,
					type: t.type,
					enabled: t.enabled,
					lastStatus: t.lastStatus,
					nextRunAt: t.nextRunAt,
				}));
			}
		} catch { /* silent */ }
	}

	function nextSchedulerLabel(iso: string | null): string {
		if (!iso) return '—';
		const ms = new Date(iso).getTime() - Date.now();
		if (ms < 0) return 'overdue';
		const mins = Math.floor(ms / 60_000);
		const hours = Math.floor(mins / 60);
		const days = Math.floor(hours / 24);
		if (days > 0) return `in ${days}d ${hours % 24}h`;
		if (hours > 0) return `in ${hours}h ${mins % 60}m`;
		return `in ${mins}m`;
	}

	const schedulerSummary = $derived.by(() => {
		const total = schedulerTasks.length;
		const active = schedulerTasks.filter((t) => t.enabled).length;
		const failed = schedulerTasks.filter((t) => t.lastStatus === 'error').length;
		const next = schedulerTasks
			.filter((t) => t.enabled && t.nextRunAt)
			.map((t) => new Date(t.nextRunAt!).getTime())
			.sort((a, b) => a - b)[0];
		return { total, active, failed, nextLabel: next ? nextSchedulerLabel(new Date(next).toISOString()) : '—' };
	});

	async function loadPlaybooks() {
		try {
			const res = await fetch('/api/playbooks');
			if (res.ok) {
				const data = await res.json();
				playbookItems = data.playbooks || [];
				playbookCount = playbookItems.length;
				playbookProviders = data.providers || {};
			}
		} catch { /* silent */ }
	}

	const zoneColors: Record<string, string> = {
		inbox: '#f59e0b',
		projects: '#6366f1',
		knowledge: '#06b6d4',
		content: '#8b5cf6',
		operations: '#64748b',
		archive: '#6b7280',
	};
	const zoneOrder = ['knowledge', 'content', 'projects', 'operations', 'inbox', 'archive'];

	async function loadVault() {
		try {
			const [statsRes, recentRes] = await Promise.all([
				fetch('/api/vault'),
				fetch('/api/vault/recent?limit=3')
			]);
			if (statsRes.ok) {
				const data = await statsRes.json();
				vaultNoteCount = data.stats?.totalNotes ?? 0;
				vaultOrphans = data.stats?.orphanNotes ?? 0;
				vaultUnresolved = data.stats?.unresolvedLinks ?? 0;
				vaultZones = data.stats?.notesByZone ?? {};
				const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
				try {
					const allRes = await fetch('/api/vault/recent?limit=200');
					if (allRes.ok) {
						const allData = await allRes.json();
						const notes = allData.notes ?? allData;
						vaultThisWeek = notes.filter((n: VaultRecent) => n.mtime > weekAgo).length;
					}
				} catch { /* silent */ }
			}
			if (recentRes.ok) {
				const data = await recentRes.json();
				vaultRecent = data.notes ?? [];
			}
		} catch { /* silent */ }
	}

	async function loadExplorerRoots() {
		try {
			const res = await fetch('/api/settings/explorer-roots');
			if (res.ok) {
				const data = await res.json();
				explorerRoots = data.roots ?? [];
			}
		} catch { /* silent */ }
	}

	let vaultEventSource: EventSource | null = null;

	let agentCount = $state(0);
	let agentsByBackend = $state<{ pty: number; cli: number; ai: number }>({ pty: 0, cli: 0, ai: 0 });

	let toolCount = $state(0);
	let toolsByCategory = $state<{ read: number; write: number; agent: number; skill: number; reply: number }>({
		read: 0, write: 0, agent: 0, skill: 0, reply: 0,
	});
	let recentToolCalls = $state(0);
	let skillCount = $state(0);

	async function loadAgents() {
		try {
			const res = await fetch('/api/agents');
			if (res.ok) {
				const data = await res.json();
				const list = (data.agents ?? []) as { backend: 'claude-pty' | 'claude-cli-flag' | 'ai-sdk' }[];
				agentCount = list.length;
				agentsByBackend = {
					pty: list.filter((a) => a.backend === 'claude-pty').length,
					cli: list.filter((a) => a.backend === 'claude-cli-flag').length,
					ai: list.filter((a) => a.backend === 'ai-sdk').length,
				};
			}
		} catch { /* silent */ }
	}

	async function loadTools() {
		try {
			const res = await fetch('/api/orchestrator/tools');
			if (res.ok) {
				const data = await res.json();
				const list = (data.tools ?? []) as { category: 'read' | 'write' | 'agent' | 'skill' | 'reply' }[];
				toolCount = list.length;
				toolsByCategory = {
					read: list.filter((t) => t.category === 'read').length,
					write: list.filter((t) => t.category === 'write').length,
					agent: list.filter((t) => t.category === 'agent').length,
					skill: list.filter((t) => t.category === 'skill').length,
					reply: list.filter((t) => t.category === 'reply').length,
				};
				recentToolCalls = (data.recent_calls ?? []).length;
			}
		} catch { /* silent */ }
	}

	async function loadSkills() {
		try {
			const res = await fetch('/api/skills');
			if (res.ok) {
				const data = await res.json();
				skillCount = (data.skills ?? []).length;
			}
		} catch { /* silent */ }
	}

	function refreshVolatile() {
		// Fires on tab focus, SSE reindex, or explicit user action.
		loadVault();
		loadDashboard();
		loadPlaybooks();
		loadExplorerRoots();
		loadScheduler();
		loadAgents();
		loadTools();
		loadSkills();
	}

	onMount(() => {
		// ADR-037: workspace listing moved to /workspaces, vault projects to /projects.
		// Homepage is now a pure dashboard — bento tiles only, no blocking loaders.
		refreshVolatile();

		const onVisible = () => { if (document.visibilityState === 'visible') refreshVolatile(); };
		document.addEventListener('visibilitychange', onVisible);

		const onVaultRefresh = () => { refreshVolatile(); };
		window.addEventListener('vault:refresh', onVaultRefresh);

		// SSE stream — live-updates when files change or healers run.
		try {
			const es = new EventSource('/api/vault/events');
			vaultEventSource = es;
			let debounce: ReturnType<typeof setTimeout> | null = null;
			es.addEventListener('reindexed', () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => { loadVault(); }, 300);
			});
			es.onerror = () => { /* browser auto-reconnects */ };
		} catch { /* SSE not supported — visibility fallback covers most cases */ }

		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('vault:refresh', onVaultRefresh);
			vaultEventSource?.close();
		};
	});
</script>

<svelte:head>
	<title>Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Main — bento dashboard. Workspaces live at /workspaces; vault projects at /projects. -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">
		<div class="max-w-3xl mx-auto">
			<!-- System Notifications -->
			<SystemNotifications />

			<!-- Bento layout — Vault is the hero (4 cols), Pipelines + Playbooks/Files balance the rows -->
			<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
				<!-- Pipelines -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<h3 class="text-sm font-semibold text-hub-text">
							Pipelines
							{#if dashboard?.pipelineSummary}
								<span class="text-hub-dim font-normal ml-1">({dashboard.pipelineSummary.total})</span>
							{/if}
						</h3>
						<div class="flex items-center gap-2">
							<a
								href="/pipelines/builder?type=pipeline"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New pipeline"
								title="New pipeline"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/pipelines" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">View all</a>
						</div>
					</div>
					{#if dashboard?.pipelineSummary && dashboard.pipelineSummary.items.length > 0}
						<div class="space-y-1.5">
							{#each dashboard.pipelineSummary.items.slice(0, 5) as item}
								<a
									href="/pipelines?name={encodeURIComponent(item.name)}"
									class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{item.name}</span>
									<span class="flex-shrink-0 w-2 h-2 rounded-full bg-hub-cta/60"></span>
								</a>
							{/each}
						</div>
					{:else}
						<p class="text-xs text-hub-dim py-3 text-center">No pipelines yet</p>
					{/if}
				</div>

				<!-- Vault (hero) -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-4">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-1.5">
							<h3 class="text-sm font-semibold text-hub-text">
								Vault
								{#if vaultNoteCount > 0}
									<span class="text-hub-dim font-normal ml-1">({vaultNoteCount})</span>
								{/if}
							</h3>
							<span class="w-2 h-2 rounded-full {vaultUnresolved > 0 ? 'bg-amber-400' : 'bg-emerald-400'}"></span>
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/vault?new=1"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New note"
								title="New note"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/vault" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">Open vault</a>
						</div>
					</div>

					<!-- Zone distribution -->
					{#if vaultNoteCount > 0 && Object.keys(vaultZones).length > 0}
						<div class="space-y-1 mb-3">
							{#each zoneOrder.filter(z => vaultZones[z]) as zone}
								{@const count = vaultZones[zone] ?? 0}
								{@const pct = Math.round((count / vaultNoteCount) * 100)}
								<div class="flex items-center gap-2">
									<span class="text-[10px] text-hub-dim w-16 text-right truncate">{zone}</span>
									<div class="flex-1 h-1.5 rounded-full bg-hub-bg overflow-hidden">
										<div
											class="h-full rounded-full transition-all duration-500"
											style="width: {pct}%; background-color: {zoneColors[zone] ?? '#64748b'}"
										></div>
									</div>
									<span class="text-[10px] text-hub-dim w-6">{count}</span>
								</div>
							{/each}
						</div>
					{/if}

					<!-- Recent notes -->
					{#if vaultRecent.length > 0}
						<div class="space-y-1.5">
							{#each vaultRecent as note}
								{@const noteType = note.meta?.type ?? 'unknown'}
								<a
									href="/vault?note={encodeURIComponent(note.path)}"
									class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<span
										class="flex-shrink-0 w-2 h-2 rounded-full"
										style="background-color: {noteTypeColors[noteType] ?? '#64748b'}"
									></span>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{note.title}</span>
								</a>
							{/each}
						</div>
					{:else}
						<p class="text-xs text-hub-dim py-3 text-center">No notes yet</p>
					{/if}

					<!-- Health + activity -->
					<div class="flex items-center gap-3 mt-2 text-[10px]">
						{#if vaultThisWeek > 0}
							<span class="text-hub-cta">+{vaultThisWeek} this week</span>
						{/if}
						{#if vaultUnresolved > 0}
							<span class="text-hub-warning">{vaultUnresolved} broken</span>
						{/if}
						{#if vaultOrphans > 0}
							<span class="text-hub-dim">{vaultOrphans} orphans</span>
						{/if}
						{#if vaultUnresolved === 0 && vaultOrphans === 0 && vaultThisWeek === 0}
							<span class="text-emerald-400">Healthy</span>
						{/if}
					</div>
				</div>

				<!-- Orchestration (ADR-016 — Agents · Skills · Tools · Metrics consolidated) -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Orchestration</h3>
						</div>
						<div class="flex items-center gap-2">
							<a href="/orchestration" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer" title="Agents · Skills · Tools · Metrics — all dispatchable layers (ADR-016)">Open</a>
						</div>
					</div>
					<a
						href="/orchestration"
						class="block group"
						title="Agents · Skills · Tools · Metrics"
					>
						<div class="flex items-center justify-around py-2">
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-purple group-hover:text-hub-info transition-colors">{agentCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">AGENTS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-warning group-hover:text-hub-info transition-colors">{skillCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">SKILLS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-emerald-400 group-hover:text-hub-info transition-colors">{toolCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">TOOLS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-info">{recentToolCalls}</div>
								<div class="text-[10px] text-hub-dim font-mono">RECENT</div>
							</div>
						</div>
						<div class="mt-2 pt-2 border-t border-hub-border/50 text-[10px] text-hub-dim text-center">
							All dispatchable layers
						</div>
					</a>
				</div>

				<!-- Scheduler -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Scheduler</h3>
							{#if schedulerSummary.total > 0}
								<span class="text-[11px] text-hub-dim bg-hub-bg px-1.5 py-0.5 rounded">{schedulerSummary.total}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/scheduler/builder"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New task"
								title="New scheduled task"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/scheduler" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">View all</a>
						</div>
					</div>
					{#if schedulerTasks.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">No tasks yet</p>
					{:else}
						<div class="space-y-1.5">
							{#each schedulerTasks.slice(0, 4) as t (t.id)}
								<a
									href="/scheduler"
									class="flex items-center justify-between py-1 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{t.id}</span>
									<span
										class="flex-shrink-0 w-2 h-2 rounded-full {!t.enabled ? 'bg-hub-dim' : t.lastStatus === 'error' ? 'bg-hub-danger' : t.lastStatus === 'success' ? 'bg-hub-cta/70' : 'bg-hub-info/60'}"
										title={t.enabled ? `${t.lastStatus ?? 'scheduled'}` : 'disabled'}
									></span>
								</a>
							{/each}
						</div>
						<div class="mt-3 pt-2 border-t border-hub-border/50 flex items-center justify-between text-[10px] text-hub-dim">
							<span>{schedulerSummary.active} active{schedulerSummary.failed > 0 ? ` · ${schedulerSummary.failed} failed` : ''}</span>
							<span>next {schedulerSummary.nextLabel}</span>
						</div>
					{/if}
				</div>

				<!-- Playbooks -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Playbooks</h3>
							{#if playbookCount > 0}
								<span class="text-[11px] text-hub-dim bg-hub-bg px-1.5 py-0.5 rounded">{playbookCount}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/playbooks/builder"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New playbook"
								title="New playbook"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/playbooks" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">View all</a>
						</div>
					</div>
					{#if playbookItems.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">No playbooks yet</p>
					{:else}
						<div class="space-y-1.5">
							{#each playbookItems.slice(0, 3) as pb}
								<a
									href="/playbooks/{encodeURIComponent(pb.name)}"
									class="block py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<div class="text-xs text-hub-muted group-hover:text-hub-text transition-colors">{pb.name}</div>
									<div class="text-[11px] text-hub-dim mt-0.5">
										{pb.roles.length} role{pb.roles.length === 1 ? '' : 's'}, {pb.phases.length} phase{pb.phases.length === 1 ? '' : 's'}
									</div>
								</a>
							{/each}
						</div>
					{/if}
					{#if Object.keys(playbookProviders).length > 0}
						<div class="mt-3 pt-2 border-t border-hub-border/50 flex gap-3 text-[10px] text-hub-dim">
							{#each Object.entries(playbookProviders) as [name, available]}
								<span class="flex items-center gap-1">
									<span class="w-1.5 h-1.5 rounded-full {available ? 'bg-hub-cta' : 'bg-hub-border'}"></span>
									{name}
								</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Files Explorer -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<h3 class="text-sm font-semibold text-hub-text">
							Files
							{#if explorerRoots.length > 0}
								<span class="text-hub-dim font-normal ml-1">({explorerRoots.length})</span>
							{/if}
						</h3>
						<div class="flex items-center gap-2">
							<a
								href="/settings#explorer-roots"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="Add root"
								title="Add root in Settings"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/files" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">Open</a>
						</div>
					</div>
					{#if explorerRoots.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">
							No folders yet.
							<a href="/settings" class="text-hub-cta hover:underline cursor-pointer">Add one</a>
							to start browsing.
						</p>
					{:else}
						<div class="space-y-1.5">
							{#each explorerRoots.slice(0, 5) as root}
								<a
									href="/files"
									class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<svg class="w-3.5 h-3.5 text-hub-cta/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
									</svg>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{root.name}</span>
									<span class="text-[10px] text-hub-dim/70 ml-auto truncate font-mono">{root.path}</span>
								</a>
							{/each}
						</div>
						{#if explorerRoots.length > 5}
							<div class="mt-2 text-[10px] text-hub-dim text-center">
								+{explorerRoots.length - 5} more
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
