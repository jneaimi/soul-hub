<script lang="ts">
	import { onMount } from 'svelte';

	type Category = 'reply' | 'read' | 'write' | 'agent' | 'skill';

	interface LiveSkill {
		name: string;
		description: string;
	}

	interface LiveAgent {
		id: string;
		description: string;
	}

	interface ToolListing {
		name: string;
		category: Category;
		llm_description: string;
		ui_description: string;
		has_config?: { settingsKey: string; label: string };
		examples?: { user: string; toolArgs: string }[];
		last_invoked_at?: number;
		recent_calls: number;
		/** Present on `invokeSkill` — the live chat-invokable skill list. */
		live_skills?: LiveSkill[];
		/** Present on `dispatchAgent` — the live chat-dispatchable + ready agent list. */
		live_agents?: LiveAgent[];
	}

	interface RecentCall {
		name: string;
		at: number;
		argPreview: string;
	}

	type FilterMode = 'all' | Category;

	let tools = $state<ToolListing[]>([]);
	let recent = $state<RecentCall[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<FilterMode>('all');
	let search = $state('');
	let expandedNames = $state(new Set<string>());

	const CATEGORY_LABEL: Record<Category, string> = {
		read: 'Read',
		write: 'Write',
		agent: 'Dispatch agent',
		skill: 'Invoke skill',
		reply: 'Reply',
	};

	const CATEGORY_DOT: Record<Category, string> = {
		read: 'bg-blue-500',
		write: 'bg-emerald-500',
		agent: 'bg-violet-500',
		skill: 'bg-amber-500',
		reply: 'bg-slate-400',
	};

	async function load() {
		try {
			const res = await fetch('/api/orchestrator/tools');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			tools = data.tools ?? [];
			recent = data.recent_calls ?? [];
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function toggleExpand(name: string) {
		if (expandedNames.has(name)) {
			const next = new Set(expandedNames);
			next.delete(name);
			expandedNames = next;
		} else {
			expandedNames = new Set([...expandedNames, name]);
		}
	}

	function fmtRelative(at: number | undefined): string {
		if (!at) return '—';
		const ms = Date.now() - at;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	const filteredTools = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return tools.filter((t) => {
			if (filter !== 'all' && t.category !== filter) return false;
			if (q) {
				const haystack = `${t.name} ${t.ui_description} ${t.llm_description}`.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			return true;
		});
	});

	const summary = $derived({
		total: tools.length,
		read: tools.filter((t) => t.category === 'read').length,
		write: tools.filter((t) => t.category === 'write').length,
		agent: tools.filter((t) => t.category === 'agent').length,
		skill: tools.filter((t) => t.category === 'skill').length,
		reply: tools.filter((t) => t.category === 'reply').length,
	});

	onMount(() => {
		load();
	});
</script>

<svelte:head>
	<title>Tools · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-screen bg-hub-bg">
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<a
				href="/"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to home"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</a>
			<div class="flex-1">
				<h1 class="text-lg font-semibold text-hub-text">Orchestrator Tools</h1>
				<p class="text-xs text-hub-muted">
					Tools the orchestrator-v2 LLM can pick from each turn. Read-only registry — tools are
					always-on. Per-item config knobs link out to settings panels where they exist.
				</p>
			</div>
			<nav class="flex items-center gap-2 text-xs text-hub-muted">
				<a class="hover:text-hub-text" href="/agents">Agents</a>
				<span>·</span>
				<a class="hover:text-hub-text" href="/skills">Skills</a>
				<span>·</span>
				<span class="text-hub-text">Tools</span>
				<span>·</span>
				<a class="hover:text-hub-text" href="/agents/orchestrator">Metrics</a>
			</nav>
		</div>
	</header>

	<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full space-y-4">
			{#if loadError}
				<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
					Failed to load: {loadError}
				</div>
			{/if}

			<!-- Summary chips -->
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<strong class="text-hub-text">{summary.total}</strong> tools
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1"></span>
					{summary.read} read
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>
					{summary.write} write
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1"></span>
					{summary.agent} agent
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1"></span>
					{summary.skill} skill
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-slate-400 mr-1"></span>
					{summary.reply} reply
				</span>
			</div>

			<!-- Filters + search -->
			<div class="flex flex-wrap items-center gap-2">
				<div class="flex items-center gap-1 text-xs">
					{#each ['all', 'read', 'write', 'agent', 'skill', 'reply'] as cat}
						<button
							class="px-2 py-1 rounded-md transition-colors {filter === cat
								? 'bg-hub-text text-hub-bg'
								: 'bg-hub-card text-hub-muted hover:text-hub-text'}"
							onclick={() => (filter = cat as FilterMode)}
						>
							{cat === 'all' ? 'All' : CATEGORY_LABEL[cat as Category]}
						</button>
					{/each}
				</div>
				<input
					type="text"
					bind:value={search}
					placeholder="Search…"
					class="flex-1 min-w-[180px] px-3 py-1.5 rounded-md bg-hub-card border border-hub-border text-sm text-hub-text placeholder:text-hub-muted focus:outline-none focus:border-hub-text/40"
				/>
			</div>

			<!-- Tool list -->
			{#if loading}
				<div class="text-sm text-hub-muted py-8 text-center">Loading…</div>
			{:else if filteredTools.length === 0}
				<div class="text-sm text-hub-muted py-8 text-center">
					No tools match the current filter.
				</div>
			{:else}
				<div class="space-y-2">
					{#each filteredTools as t (t.name)}
						{@const expanded = expandedNames.has(t.name)}
						<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden">
							<button
								class="w-full flex items-start gap-3 px-4 py-3 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
								onclick={() => toggleExpand(t.name)}
							>
								<span class="mt-1 inline-block w-2 h-2 rounded-full {CATEGORY_DOT[t.category]} flex-shrink-0"></span>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<code class="text-sm font-mono text-hub-text">{t.name}</code>
										<span class="text-[10px] uppercase tracking-wide text-hub-muted">
											{CATEGORY_LABEL[t.category]}
										</span>
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">always on</span>
										{#if t.has_config}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">configurable</span>
										{/if}
									</div>
									<p class="text-xs text-hub-muted mt-1">{t.ui_description}</p>
									<div class="text-[11px] text-hub-muted mt-1 flex gap-3">
										<span>last: {fmtRelative(t.last_invoked_at)}</span>
										<span>recent: {t.recent_calls}</span>
									</div>
								</div>
								<svg
									class="w-4 h-4 text-hub-muted flex-shrink-0 transition-transform {expanded
										? 'rotate-180'
										: ''}"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</button>
							{#if expanded}
								<div class="border-t border-hub-border px-4 py-3 space-y-3 bg-hub-bg/40">
									<div>
										<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
											LLM description (what the model sees)
										</div>
										<p class="text-xs text-hub-text whitespace-pre-wrap">{t.llm_description}</p>
									</div>
									{#if t.has_config}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Configurable
											</div>
											<a
												href="/settings"
												class="text-xs text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline"
											>
												{t.has_config.label} <span class="text-hub-muted">({t.has_config.settingsKey})</span>
											</a>
										</div>
									{/if}
									{#if t.live_skills && t.live_skills.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live skills ({t.live_skills.length})
											</div>
											<ul class="space-y-1.5">
												{#each t.live_skills as s}
													<li class="text-xs flex items-baseline gap-2">
														<a
															href="/skills"
															class="font-mono text-hub-text hover:text-blue-300 underline-offset-2 hover:underline"
															title="Edit skill overlay on /skills"
														>
															{s.name}
														</a>
														<span class="text-hub-muted truncate">{s.description}</span>
													</li>
												{/each}
											</ul>
										</div>
									{:else if t.name === 'invokeSkill'}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live skills
											</div>
											<p class="text-xs text-hub-muted">
												No chat-invokable skills enabled. <a href="/skills" class="text-blue-300 hover:underline">Configure on /skills</a>.
											</p>
										</div>
									{/if}
									{#if t.live_agents && t.live_agents.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live agents ({t.live_agents.length})
											</div>
											<ul class="space-y-1.5">
												{#each t.live_agents as a}
													<li class="text-xs flex items-baseline gap-2">
														<a
															href={`/agents/${a.id}`}
															class="font-mono text-hub-text hover:text-blue-300 underline-offset-2 hover:underline"
															title="Open agent detail"
														>
															{a.id}
														</a>
														<span class="text-hub-muted truncate">{a.description}</span>
													</li>
												{/each}
											</ul>
										</div>
									{:else if t.name === 'dispatchAgent'}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live agents
											</div>
											<p class="text-xs text-hub-muted">
												No chat-dispatchable + ready agents. <a href="/agents" class="text-blue-300 hover:underline">Configure on /agents</a>.
											</p>
										</div>
									{/if}
									{#if t.examples && t.examples.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Examples
											</div>
											<ul class="space-y-2">
												{#each t.examples as ex}
													<li class="text-xs">
														<div class="text-hub-text">{ex.user}</div>
														<code class="block text-[11px] text-hub-muted font-mono">→ {ex.toolArgs}</code>
													</li>
												{/each}
											</ul>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Recent invocations (read-only ring buffer) -->
			{#if recent.length > 0}
				<section class="mt-6">
					<h2 class="text-sm font-semibold text-hub-text mb-2">Recent invocations</h2>
					<p class="text-[11px] text-hub-muted mb-2">
						In-memory ring buffer (last 50). Resets on PM2 reload. Persistent telemetry is Phase B.
					</p>
					<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden divide-y divide-hub-border">
						{#each recent as c}
							<div class="px-3 py-2 text-xs flex items-start gap-3">
								<code class="text-hub-text font-mono">{c.name}</code>
								<span class="text-hub-muted flex-shrink-0">{fmtRelative(c.at)}</span>
								<code class="flex-1 text-[11px] text-hub-muted font-mono truncate">{c.argPreview}</code>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		</div>
	</main>
</div>
