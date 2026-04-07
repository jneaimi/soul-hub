<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		projectName: string;
		codePath: string | null;
	}

	interface SkillEntry {
		name: string;
		description: string;
		category: string;
		runtime?: string;
		userOnly?: boolean;
		tags?: string[];
	}

	interface AgentEntry {
		name: string;
		description: string;
		category: string;
		model?: string;
		effort?: string;
		dependsOn?: string[];
		tags?: string[];
	}

	interface McpEntry {
		name: string;
		description: string;
		category: string;
		command?: string;
		args?: string[];
		url?: string;
		env_vars?: { name: string; description: string; required: boolean }[];
		tags?: string[];
	}

	let { projectName, codePath }: Props = $props();

	let activeTab = $state<'skills' | 'agents' | 'mcp'>('skills');
	let skills = $state<SkillEntry[]>([]);
	let agents = $state<AgentEntry[]>([]);
	let mcpServers = $state<McpEntry[]>([]);
	let loading = $state(true);
	let installing = $state<string | null>(null);
	let installed = $state<Set<string>>(new Set());
	let message = $state<{ text: string; type: 'success' | 'error' } | null>(null);

	onMount(async () => {
		try {
			const res = await fetch('/api/catalog');
			if (res.ok) {
				const data = await res.json();
				skills = data.skills || [];
				agents = data.agents || [];
				mcpServers = data.mcpServers || [];
			}
		} catch {
			// silent
		} finally {
			loading = false;
		}

		// Check what's already installed
		if (codePath) {
			try {
				const skillsRes = await fetch(`/api/files?path=${encodeURIComponent(codePath + '/.claude/skills')}`);
				if (skillsRes.ok) {
					const data = await skillsRes.json();
					for (const entry of data.entries) {
						if (entry.type === 'dir') installed.add(`skill:${entry.name}`);
					}
				}
			} catch { /* no skills dir yet */ }

			try {
				const agentsRes = await fetch(`/api/files?path=${encodeURIComponent(codePath + '/.claude/agents')}`);
				if (agentsRes.ok) {
					const data = await agentsRes.json();
					for (const entry of data.entries) {
						if (entry.type === 'file' && entry.name.endsWith('.md')) {
							installed.add(`agent:${entry.name.replace('.md', '')}`);
						}
					}
				}
			} catch { /* no agents dir yet */ }

			// Check installed MCP servers from .mcp.json
			try {
				const mcpRes = await fetch(`/api/files?action=read&path=${encodeURIComponent(codePath + '/.mcp.json')}`);
				if (mcpRes.ok) {
					const data = await mcpRes.json();
					const parsed = JSON.parse(data.content || '{}');
					for (const name of Object.keys(parsed.mcpServers || {})) {
						installed.add(`mcp:${name}`);
					}
				}
			} catch { /* no .mcp.json yet */ }

			installed = new Set(installed);
		}
	});

	async function install(type: 'skill' | 'agent' | 'mcp', name: string) {
		if (!codePath || installing) return;
		installing = `${type}:${name}`;
		message = null;

		try {
			const res = await fetch('/api/catalog/install', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type, name, projectPath: codePath }),
			});

			if (res.ok) {
				installed.add(`${type}:${name}`);
				installed = new Set(installed);
				message = { text: `Installed ${name}`, type: 'success' };
			} else {
				const data = await res.json();
				message = { text: data.error || 'Install failed', type: 'error' };
			}
		} catch {
			message = { text: 'Network error', type: 'error' };
		} finally {
			installing = null;
			setTimeout(() => message = null, 3000);
		}
	}

	const categoryColors: Record<string, string> = {
		development: 'bg-hub-cta/15 text-hub-cta',
		content: 'bg-hub-purple/15 text-hub-purple',
		research: 'bg-hub-info/15 text-hub-info',
		media: 'bg-hub-warning/15 text-hub-warning',
		operations: 'bg-hub-danger/15 text-hub-danger',
	};
</script>

<div class="flex flex-col h-full bg-hub-surface/50">
	<!-- Tabs -->
	<div class="flex-shrink-0 flex border-b border-hub-border/50">
		<button
			onclick={() => activeTab = 'skills'}
			class="flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer
				{activeTab === 'skills' ? 'text-hub-text border-b-2 border-hub-cta bg-hub-surface' : 'text-hub-dim hover:text-hub-muted'}"
		>
			Skills ({skills.length})
		</button>
		<button
			onclick={() => activeTab = 'agents'}
			class="flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer
				{activeTab === 'agents' ? 'text-hub-text border-b-2 border-hub-purple bg-hub-surface' : 'text-hub-dim hover:text-hub-muted'}"
		>
			Agents ({agents.length})
		</button>
		<button
			onclick={() => activeTab = 'mcp'}
			class="flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer
				{activeTab === 'mcp' ? 'text-hub-text border-b-2 border-hub-info bg-hub-surface' : 'text-hub-dim hover:text-hub-muted'}"
		>
			MCP ({mcpServers.length})
		</button>
	</div>

	<!-- Message toast -->
	{#if message}
		<div class="px-3 py-2 text-xs {message.type === 'success' ? 'bg-hub-cta/10 text-hub-cta' : 'bg-hub-danger/10 text-hub-danger'}">
			{message.text}
		</div>
	{/if}

	<!-- List -->
	<div class="flex-1 overflow-y-auto">
		{#if loading}
			<div class="flex items-center justify-center py-8">
				<span class="text-xs text-hub-dim">Loading catalog...</span>
			</div>
		{:else if activeTab === 'skills'}
			{#each skills as skill (skill.name)}
				{@const isInstalled = installed.has(`skill:${skill.name}`)}
				{@const isInstalling = installing === `skill:${skill.name}`}
				<div class="px-3 py-2.5 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex items-center gap-1.5 mb-0.5">
								<span class="text-xs font-medium text-hub-text">{skill.name}</span>
								<span class="text-[9px] px-1 py-0.5 rounded {categoryColors[skill.category] || 'bg-hub-dim/15 text-hub-dim'}">{skill.category}</span>
								{#if skill.runtime}
									<span class="text-[9px] px-1 py-0.5 rounded bg-hub-card text-hub-dim">{skill.runtime}</span>
								{/if}
							</div>
							<p class="text-[11px] text-hub-dim leading-snug">{skill.description}</p>
						</div>
						<button
							onclick={() => install('skill', skill.name)}
							disabled={isInstalled || isInstalling || !codePath}
							class="flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer
								{isInstalled ? 'bg-hub-cta/10 text-hub-cta' : 'bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-dim'}
								disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isInstalling ? '...' : isInstalled ? 'Installed' : 'Add'}
						</button>
					</div>
				</div>
			{/each}
		{:else if activeTab === 'agents'}
			{#each agents as agent (agent.name)}
				{@const isInstalled = installed.has(`agent:${agent.name}`)}
				{@const isInstalling = installing === `agent:${agent.name}`}
				<div class="px-3 py-2.5 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex items-center gap-1.5 mb-0.5">
								<span class="text-xs font-medium text-hub-text">{agent.name}</span>
								<span class="text-[9px] px-1 py-0.5 rounded {categoryColors[agent.category] || 'bg-hub-dim/15 text-hub-dim'}">{agent.category}</span>
								{#if agent.model}
									<span class="text-[9px] px-1 py-0.5 rounded bg-hub-purple/10 text-hub-purple">{agent.model}</span>
								{/if}
							</div>
							<p class="text-[11px] text-hub-dim leading-snug">{agent.description}</p>
							{#if agent.dependsOn?.length}
								<p class="text-[10px] text-hub-warning mt-0.5">Needs: {agent.dependsOn.join(', ')}</p>
							{/if}
						</div>
						<button
							onclick={() => install('agent', agent.name)}
							disabled={isInstalled || isInstalling || !codePath}
							class="flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer
								{isInstalled ? 'bg-hub-purple/10 text-hub-purple' : 'bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-dim'}
								disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isInstalling ? '...' : isInstalled ? 'Installed' : 'Add'}
						</button>
					</div>
				</div>
			{/each}
		{:else if activeTab === 'mcp'}
			{#each mcpServers as mcp (mcp.name)}
				{@const isInstalled = installed.has(`mcp:${mcp.name}`)}
				{@const isInstalling = installing === `mcp:${mcp.name}`}
				<div class="px-3 py-2.5 border-b border-hub-border/30 hover:bg-hub-card/30 transition-colors">
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0">
							<div class="flex items-center gap-1.5 mb-0.5">
								<span class="text-xs font-medium text-hub-text">{mcp.name}</span>
								<span class="text-[9px] px-1 py-0.5 rounded {categoryColors[mcp.category] || 'bg-hub-dim/15 text-hub-dim'}">{mcp.category}</span>
								<span class="text-[9px] px-1 py-0.5 rounded bg-hub-info/10 text-hub-info">{mcp.url ? 'http' : 'stdio'}</span>
							</div>
							<p class="text-[11px] text-hub-dim leading-snug">{mcp.description}</p>
							{#if mcp.env_vars?.length}
								<p class="text-[10px] text-hub-warning mt-0.5">Needs: {mcp.env_vars.map(e => e.name).join(', ')}</p>
							{/if}
						</div>
						<button
							onclick={() => install('mcp', mcp.name)}
							disabled={isInstalled || isInstalling || !codePath}
							class="flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer
								{isInstalled ? 'bg-hub-info/10 text-hub-info' : 'bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-dim'}
								disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isInstalling ? '...' : isInstalled ? 'Installed' : 'Add'}
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
