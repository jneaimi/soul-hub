<script lang="ts">
	import { onMount } from 'svelte';
	import ChannelCard from '$lib/components/ChannelCard.svelte';
	import PlatformEnv from '$lib/components/PlatformEnv.svelte';

	type ChannelAction = 'send' | 'prompt' | 'listen';

	interface ChannelMetaItem {
		id: string;
		name: string;
		icon: string;
		fields: { key: string; label: string; type: string; env: string }[];
		actions: ChannelAction[];
		configured: boolean;
		missingEnv: string[];
	}

	interface ChannelConfigItem {
		enabled: boolean;
		label: string;
		defaultFor: ChannelAction[];
	}

	// Settings state
	let fontSize = $state(13);
	let cols = $state(120);
	let rows = $state(40);
	let cursorBlink = $state(true);

	let defaultPanel = $state<'code' | 'closed'>('code');
	let panelWidth = $state(260);

	let devDir = $state('~/dev');
	let catalogDir = $state('~/dev/soul-hub/catalog');
	let claudeBinary = $state('~/.local/bin/claude');

	// Channels state
	let channelMetas = $state<ChannelMetaItem[]>([]);
	let channelConfigs = $state<Record<string, ChannelConfigItem>>({});

	// System health (read-only)
	let serverHealth = $state<{
		nodeRunning: boolean;
		tunnelRunning: boolean;
		port: number;
		domain: string;
	} | null>(null);

	let knowledgeDb = $state<{
		exists: boolean;
		noteCount: number | null;
		dbSizeBytes: number | null;
		lastModified: string | null;
	} | null>(null);

	// UI state
	let saving = $state(false);
	let toast = $state<{ message: string; type: 'success' | 'error' } | null>(null);
	let dirty = $state(false);

	function markDirty() {
		dirty = true;
	}

	onMount(async () => {
		// Load settings from server
		try {
			const res = await fetch('/api/settings');
			if (res.ok) {
				const data = await res.json();
				if (data.terminal) {
					fontSize = data.terminal.fontSize ?? 13;
					cols = data.terminal.cols ?? 120;
					rows = data.terminal.rows ?? 40;
					cursorBlink = data.terminal.cursorBlink ?? true;
				}
				if (data.interface) {
					defaultPanel = data.interface.defaultPanel ?? 'code';
					panelWidth = data.interface.panelWidth ?? 260;
				}
				if (data.paths) {
					devDir = data.paths.devDir ?? '~/dev';
					catalogDir = data.paths.catalogDir ?? '~/dev/soul-hub/catalog';
					claudeBinary = data.paths.claudeBinary ?? '~/.local/bin/claude';
				}
				if (data.channels) {
					channelConfigs = data.channels;
				}
			}
		} catch { /* use defaults */ }

		// Load channel adapter metadata
		try {
			const res = await fetch('/api/channels/meta');
			if (res.ok) {
				channelMetas = await res.json();
				// Ensure all adapters have a config entry (use defaults for new ones)
				for (const m of channelMetas) {
					if (!channelConfigs[m.id]) {
						channelConfigs[m.id] = {
							enabled: m.configured,
							label: m.name,
							defaultFor: m.actions.includes('send') ? ['send'] : [],
						};
					}
				}
			}
		} catch { /* ignore */ }

		// Load UI overrides from localStorage
		const prefs = localStorage.getItem('soul-hub-prefs');
		if (prefs) {
			try {
				const p = JSON.parse(prefs);
				if (p.fontSize) fontSize = p.fontSize;
				if (p.cursorBlink !== undefined) cursorBlink = p.cursorBlink;
				if (p.defaultPanel) defaultPanel = p.defaultPanel;
				if (p.panelWidth) panelWidth = p.panelWidth;
			} catch { /* ignore */ }
		}

		// Load system health
		try {
			const res = await fetch('/api/system-health');
			if (res.ok) {
				const data = await res.json();
				serverHealth = data.server;
				knowledgeDb = data.knowledgeDb;
			}
		} catch { /* ignore */ }
	});

	async function save() {
		saving = true;
		toast = null;

		try {
			// Save to settings.json (paths + terminal + interface)
			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					terminal: { fontSize, cols, rows, cursorBlink },
					interface: { defaultPanel, panelWidth },
					paths: { devDir, catalogDir, claudeBinary },
					channels: channelConfigs,
				}),
			});

			if (!res.ok) throw new Error('Failed to save');

			// Save UI prefs to localStorage
			localStorage.setItem('soul-hub-prefs', JSON.stringify({
				fontSize, cursorBlink, defaultPanel, panelWidth,
			}));

			dirty = false;
			toast = { message: 'Settings saved', type: 'success' };
		} catch {
			toast = { message: 'Failed to save settings', type: 'error' };
		} finally {
			saving = false;
			setTimeout(() => { toast = null; }, 3000);
		}
	}

	function handleChannelChange(id: string, cfg: ChannelConfigItem) {
		channelConfigs = { ...channelConfigs, [id]: cfg };
		markDirty();
	}

	function resetToDefaults() {
		fontSize = 13;
		cols = 120;
		rows = 40;
		cursorBlink = true;
		defaultPanel = 'code';
		panelWidth = 260;
		devDir = '~/dev';
		catalogDir = '~/dev/soul-hub/catalog';
		claudeBinary = '~/.local/bin/claude';
		dirty = true;
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', {
			year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit',
		});
	}
</script>

<svelte:head>
	<title>Settings — Soul Hub</title>
</svelte:head>

<!-- Toast notification -->
{#if toast}
	<div
		class="fixed top-4 right-4 z-50 px-4 py-3 rounded-lg border-l-4 text-sm font-medium shadow-lg transition-all
			{toast.type === 'success' ? 'bg-hub-surface border-hub-cta text-hub-cta' : 'bg-hub-surface border-hub-danger text-hub-danger'}"
	>
		{toast.message}
	</div>
{/if}

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-3xl mx-auto flex items-center gap-3">
			<a href="/" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to home">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2">
				<img src="/logo.png" alt="Soul Hub" class="w-5 h-5" />
				<h1 class="text-lg font-semibold text-hub-text">Settings</h1>
			</div>
			<div class="flex-1"></div>
			<button
				onclick={save}
				disabled={saving || !dirty}
				class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
					{dirty ? 'bg-hub-cta text-black hover:bg-hub-cta-hover' : 'bg-hub-card text-hub-dim cursor-not-allowed'}"
			>
				{saving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">
	<div class="max-w-3xl mx-auto">

		<!-- Terminal section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-4">Terminal</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="fontSize" class="block text-xs text-hub-muted mb-1">Font size (px)</label>
						<input
							id="fontSize"
							type="number"
							bind:value={fontSize}
							oninput={markDirty}
							min="8"
							max="24"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="cols" class="block text-xs text-hub-muted mb-1">Columns</label>
						<input
							id="cols"
							type="number"
							bind:value={cols}
							oninput={markDirty}
							min="40"
							max="300"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="rows" class="block text-xs text-hub-muted mb-1">Rows</label>
						<input
							id="rows"
							type="number"
							bind:value={rows}
							oninput={markDirty}
							min="10"
							max="100"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div class="flex items-center gap-3 pt-4">
						<label for="cursorBlink" class="text-xs text-hub-muted">Cursor blink</label>
						<button
							id="cursorBlink"
							type="button"
							role="switch"
							aria-checked={cursorBlink}
							onclick={() => { cursorBlink = !cursorBlink; markDirty(); }}
							class="relative w-9 h-5 rounded-full transition-colors cursor-pointer
								{cursorBlink ? 'bg-hub-cta' : 'bg-hub-border'}"
						>
							<span
								class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform
									{cursorBlink ? 'translate-x-4' : 'translate-x-0'}"
							></span>
						</button>
					</div>
				</div>
			</div>
		</section>

		<!-- Interface section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-4">Interface</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="defaultPanel" class="block text-xs text-hub-muted mb-1">Default panel</label>
						<select
							id="defaultPanel"
							bind:value={defaultPanel}
							onchange={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 cursor-pointer"
						>
							<option value="code">Code</option>
							<option value="closed">Closed</option>
						</select>
					</div>
					<div>
						<label for="panelWidth" class="block text-xs text-hub-muted mb-1">Panel width (px)</label>
						<input
							id="panelWidth"
							type="number"
							bind:value={panelWidth}
							oninput={markDirty}
							min="180"
							max="500"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
				</div>
			</div>
		</section>

		<!-- Paths section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Paths</h2>
					<span class="text-[10px] text-hub-warning font-medium">Requires restart</span>
				</div>
				<div class="space-y-3">
					<div>
						<label for="devDir" class="block text-xs text-hub-muted mb-1">Dev projects</label>
						<input
							id="devDir"
							type="text"
							bind:value={devDir}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="catalogDir" class="block text-xs text-hub-muted mb-1">Catalog</label>
						<input
							id="catalogDir"
							type="text"
							bind:value={catalogDir}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="claudeBinary" class="block text-xs text-hub-muted mb-1">Claude binary</label>
						<input
							id="claudeBinary"
							type="text"
							bind:value={claudeBinary}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
				</div>
			</div>
		</section>

		<!-- Server section (read-only) -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Server</h2>
					<span class="text-[10px] text-hub-dim font-medium">Read only</span>
				</div>
				{#if serverHealth}
					<div class="grid grid-cols-2 gap-3 text-sm">
						<div class="flex items-center gap-2">
							<span class="text-hub-muted">Port</span>
							<span class="text-hub-text font-mono">{serverHealth.port}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="text-hub-muted">Domain</span>
							<span class="text-hub-text font-mono text-xs">{serverHealth.domain}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-full {serverHealth.nodeRunning ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
							<span class="text-hub-muted">Node</span>
							<span class="text-hub-text">{serverHealth.nodeRunning ? 'Running' : 'Stopped'}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-full {serverHealth.tunnelRunning ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
							<span class="text-hub-muted">Tunnel</span>
							<span class="text-hub-text">{serverHealth.tunnelRunning ? 'Connected' : 'Disconnected'}</span>
						</div>
					</div>
				{:else}
					<div class="text-sm text-hub-dim">Loading...</div>
				{/if}
			</div>
		</section>

		<!-- Knowledge DB section (read-only) -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Knowledge DB</h2>
					<span class="text-[10px] text-hub-dim font-medium">Read only</span>
				</div>
				{#if knowledgeDb}
					{#if knowledgeDb.exists}
						<div class="grid grid-cols-3 gap-3 text-sm">
							<div>
								<span class="block text-xs text-hub-muted mb-0.5">Notes indexed</span>
								<span class="text-hub-text font-mono">{knowledgeDb.noteCount ?? '—'}</span>
							</div>
							<div>
								<span class="block text-xs text-hub-muted mb-0.5">DB size</span>
								<span class="text-hub-text font-mono">{knowledgeDb.dbSizeBytes ? formatBytes(knowledgeDb.dbSizeBytes) : '—'}</span>
							</div>
							<div>
								<span class="block text-xs text-hub-muted mb-0.5">Last modified</span>
								<span class="text-hub-text text-xs">{knowledgeDb.lastModified ? formatDate(knowledgeDb.lastModified) : '—'}</span>
							</div>
						</div>
					{:else}
						<div class="text-sm text-hub-dim">Knowledge DB not found at ~/dev/knowledge-db/knowledge.db</div>
					{/if}
				{:else}
					<div class="text-sm text-hub-dim">Loading...</div>
				{/if}
			</div>
		</section>

		<!-- Platform Environment section -->
		<PlatformEnv />

		<!-- Channels section -->
		{#if channelMetas.length > 0}
			<section class="mb-6">
				<div class="mb-2">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider px-1">Channels</h2>
				</div>
				<div class="space-y-3">
					{#each channelMetas as meta (meta.id)}
						<ChannelCard
							{meta}
							config={channelConfigs[meta.id] || { enabled: false, label: meta.name, defaultFor: [] }}
							onchange={handleChannelChange}
						/>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Reset -->
		<div class="flex justify-end">
			<button
				onclick={resetToDefaults}
				class="text-xs text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
			>
				Reset to defaults
			</button>
		</div>
	</div>
	</div>
</div>
