<script lang="ts">
	interface EnvEntry {
		key: string;
		set: boolean;
		source: 'platform' | 'shell';
	}

	interface KnownVar {
		key: string;
		description: string;
		usedBy: string[];
		required: boolean;
	}

	// Known platform env vars — declared by skills, agents, and channels
	// This is the single source of truth for what env vars Soul Hub needs
	const KNOWN_VARS: KnownVar[] = [
		{ key: 'TELEGRAM_BOT_TOKEN', description: 'Telegram Bot API token', usedBy: ['telegram channel'], required: false },
		{ key: 'TELEGRAM_CHAT_ID', description: 'Telegram chat ID for notifications', usedBy: ['telegram channel'], required: false },
		{ key: 'APIDIRECT_API_KEY', description: 'API key for Twitter, Reddit, TikTok, Instagram, LinkedIn', usedBy: ['collect skill', 'research skill', 'recipe skill'], required: false },
		{ key: 'YOUTUBE_API_KEY', description: 'YouTube Data API key', usedBy: ['collect skill', 'research skill'], required: false },
		{ key: 'GOOGLE_API_KEY', description: 'Google Gemini image + Veo video generation', usedBy: ['generate skill', 'media-creator agent'], required: false },
		{ key: 'ELEVENLABS_API_KEY', description: 'ElevenLabs text-to-speech', usedBy: ['generate skill', 'media-creator agent'], required: false },
		{ key: 'RESEND_API_KEY', description: 'Resend email API for newsletters', usedBy: ['newsletter skill'], required: false },
		{ key: 'LINEAR_API_KEY', description: 'Linear project management API', usedBy: ['claude-soul agents'], required: false },
		{ key: 'HF_API_TOKEN', description: 'Hugging Face Inference API (optional)', usedBy: ['research skill'], required: false },
	];

	let secrets = $state<EnvEntry[]>([]);
	let loading = $state(true);

	// Edit state
	let editingKey = $state<string | null>(null);
	let editValue = $state('');
	let saving = $state(false);
	let saveResult = $state<{ ok: boolean; key: string } | null>(null);

	// Add new secret
	let addingNew = $state(false);
	let newKey = $state('');
	let newValue = $state('');

	// Merge known vars with actual state
	let envList = $derived.by(() => {
		const setKeys = new Set(secrets.map((s) => s.key));
		const result: (KnownVar & { set: boolean })[] = [];

		// Add known vars first (in defined order)
		for (const known of KNOWN_VARS) {
			result.push({ ...known, set: setKeys.has(known.key) || secrets.some((s) => s.key === known.key && s.set) });
		}

		// Add any unknown vars from secrets.env that aren't in KNOWN_VARS
		for (const s of secrets) {
			if (!KNOWN_VARS.some((k) => k.key === s.key)) {
				result.push({
					key: s.key,
					description: 'Custom secret',
					usedBy: [],
					required: false,
					set: s.set,
				});
			}
		}

		return result;
	});

	async function loadSecrets() {
		loading = true;
		try {
			const res = await fetch('/api/secrets');
			if (res.ok) secrets = await res.json();
		} catch { /* ignore */ }
		loading = false;
	}

	// Load on mount
	import { onMount } from 'svelte';
	onMount(loadSecrets);

	function startEditing(key: string) {
		editingKey = key;
		editValue = '';
	}

	function cancelEditing() {
		editingKey = null;
		editValue = '';
	}

	async function saveSecret(key: string) {
		if (!editValue.trim()) return;
		saving = true;
		try {
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value: editValue.trim() }),
			});
			const data = await res.json();
			if (data.ok) {
				editingKey = null;
				editValue = '';
				saveResult = { ok: true, key };
				await loadSecrets();
				setTimeout(() => { saveResult = null; }, 3000);
			}
		} catch { /* ignore */ }
		saving = false;
	}

	async function removeSecret(key: string) {
		try {
			await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'remove', key }),
			});
			await loadSecrets();
		} catch { /* ignore */ }
	}

	function startAddNew() {
		addingNew = true;
		newKey = '';
		newValue = '';
	}

	function cancelAddNew() {
		addingNew = false;
		newKey = '';
		newValue = '';
	}

	async function saveNewSecret() {
		if (!newKey.trim() || !newValue.trim()) return;
		saving = true;
		try {
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key: newKey.trim(), value: newValue.trim() }),
			});
			const data = await res.json();
			if (data.ok) {
				addingNew = false;
				newKey = '';
				newValue = '';
				await loadSecrets();
			}
		} catch { /* ignore */ }
		saving = false;
	}
</script>

<section class="mb-4">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Platform Environment</h2>
			<span class="text-[10px] text-hub-dim font-medium">
				{envList.filter((e) => e.set).length}/{envList.length} configured
			</span>
		</div>

		{#if loading}
			<div class="text-sm text-hub-dim">Loading...</div>
		{:else}
			<div class="space-y-2">
				{#each envList as entry (entry.key)}
					<div class="flex items-start gap-3 py-2 {entry !== envList[envList.length - 1] ? 'border-b border-hub-border/50' : ''}">
						<!-- Status dot -->
						<span class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 {entry.set ? 'bg-hub-cta' : 'bg-hub-border'}"></span>

						<!-- Info -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="text-sm font-mono text-hub-text">{entry.key}</span>
								{#if saveResult?.ok && saveResult.key === entry.key}
									<span class="text-[10px] text-hub-cta">Saved</span>
								{/if}
							</div>
							<div class="text-[11px] text-hub-dim mt-0.5">{entry.description}</div>
							{#if entry.usedBy.length > 0}
								<div class="text-[10px] text-hub-muted mt-0.5">
									Used by: {entry.usedBy.join(', ')}
								</div>
							{/if}

							<!-- Inline edit -->
							{#if editingKey === entry.key}
								<div class="flex items-center gap-2 mt-2">
									<input
										type="password"
										bind:value={editValue}
										placeholder="Paste value..."
										class="flex-1 bg-hub-bg border border-hub-cta/50 rounded-md px-2.5 py-1 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
										onkeydown={(e) => { if (e.key === 'Enter') saveSecret(entry.key); if (e.key === 'Escape') cancelEditing(); }}
									/>
									<button
										onclick={() => saveSecret(entry.key)}
										disabled={saving || !editValue.trim()}
										class="px-2 py-1 text-xs font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
									>
										{saving ? '...' : 'Save'}
									</button>
									<button
										onclick={cancelEditing}
										class="px-2 py-1 text-xs text-hub-muted hover:text-hub-text cursor-pointer"
									>
										Cancel
									</button>
								</div>
							{/if}
						</div>

						<!-- Actions -->
						{#if editingKey !== entry.key}
							<div class="flex items-center gap-1 flex-shrink-0">
								<button
									onclick={() => startEditing(entry.key)}
									class="px-2 py-1 text-[11px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta transition-colors cursor-pointer"
								>
									{entry.set ? 'Change' : 'Set'}
								</button>
								{#if entry.set}
									<button
										onclick={() => removeSecret(entry.key)}
										class="px-2 py-1 text-[11px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-danger hover:border-hub-danger transition-colors cursor-pointer"
										aria-label="Remove {entry.key}"
									>
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
										</svg>
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Add new secret -->
			{#if addingNew}
				<div class="mt-3 pt-3 border-t border-hub-border space-y-2">
					<input
						type="text"
						bind:value={newKey}
						placeholder="SECRET_NAME (UPPER_SNAKE_CASE)"
						class="w-full bg-hub-bg border border-hub-border rounded-md px-2.5 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
					<input
						type="password"
						bind:value={newValue}
						placeholder="Value..."
						class="w-full bg-hub-bg border border-hub-border rounded-md px-2.5 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						onkeydown={(e) => { if (e.key === 'Enter') saveNewSecret(); if (e.key === 'Escape') cancelAddNew(); }}
					/>
					<div class="flex items-center gap-2">
						<button
							onclick={saveNewSecret}
							disabled={saving || !newKey.trim() || !newValue.trim()}
							class="px-2.5 py-1 text-xs font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
						>
							{saving ? '...' : 'Add'}
						</button>
						<button
							onclick={cancelAddNew}
							class="px-2.5 py-1 text-xs text-hub-muted hover:text-hub-text cursor-pointer"
						>
							Cancel
						</button>
					</div>
				</div>
			{:else}
				<button
					onclick={startAddNew}
					class="mt-3 flex items-center gap-1.5 text-xs text-hub-muted hover:text-hub-cta transition-colors cursor-pointer"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					Add secret
				</button>
			{/if}
		{/if}
	</div>
</section>
