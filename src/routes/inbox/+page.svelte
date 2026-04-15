<script lang="ts">
	import { onMount } from 'svelte';

	interface Account {
		id: string;
		label: string;
		provider: string;
		email: string;
		status: string;
		lastSync: number | null;
		lastError: string | null;
	}

	interface Message {
		id: number;
		accountId: string;
		subject: string;
		fromAddress: string;
		fromName: string | null;
		toAddress: string;
		dateSent: number | null;
		dateReceived: number;
		flags: string[];
		hasAttachments: boolean;
		bodyPreview: string;
	}

	let accounts = $state<Account[]>([]);
	let messages = $state<Message[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let search = $state('');
	let selectedAccount = $state<string | null>(null);
	let selectedMessage = $state<Message | null>(null);
	let stats = $state<{ accounts: number; messages: number; lastSync: number | null }>({ accounts: 0, messages: 0, lastSync: null });

	// Add account form
	let showAddForm = $state(false);
	let addProvider = $state('icloud');
	let addEmail = $state('');
	let addPassword = $state('');
	let addLabel = $state('');
	let addError = $state('');
	let adding = $state(false);

	async function loadAccounts() {
		try {
			const res = await fetch('/api/inbox/accounts');
			if (res.ok) {
				const data = await res.json();
				accounts = data.accounts ?? [];
			}
		} catch { /* silent */ }
	}

	async function loadMessages() {
		loading = true;
		try {
			const params = new URLSearchParams();
			if (selectedAccount) params.set('account', selectedAccount);
			if (search) params.set('search', search);
			params.set('limit', '50');

			const res = await fetch(`/api/inbox/messages?${params}`);
			if (res.ok) {
				const data = await res.json();
				messages = data.messages ?? [];
				total = data.total ?? 0;
				stats = data.stats ?? stats;
			}
		} catch { /* silent */ }
		loading = false;
	}

	async function addAccount() {
		addError = '';
		if (!addEmail.includes('@')) { addError = 'Valid email required'; return; }
		if (!addPassword) { addError = 'Password / app-specific password required'; return; }

		adding = true;
		try {
			const res = await fetch('/api/inbox/accounts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: addProvider,
					email: addEmail,
					credential: addPassword,
					label: addLabel || addEmail,
				}),
			});
			const data = await res.json();
			if (res.ok) {
				showAddForm = false;
				addEmail = '';
				addPassword = '';
				addLabel = '';
				await loadAccounts();
				await loadMessages();
			} else {
				addError = data.error || 'Failed to add account';
			}
		} catch (err) {
			addError = 'Network error';
		}
		adding = false;
	}

	async function removeAccount(id: string) {
		try {
			await fetch('/api/inbox/accounts', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id }),
			});
			await loadAccounts();
			await loadMessages();
		} catch { /* silent */ }
	}

	function timeAgo(ts: number): string {
		const diff = Date.now() - ts;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'now';
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	function formatFrom(msg: Message): string {
		return msg.fromName || msg.fromAddress.split('@')[0];
	}

	const providerColors: Record<string, string> = {
		icloud: 'bg-blue-500/15 text-blue-400',
		gmail: 'bg-red-500/15 text-red-400',
		outlook: 'bg-sky-500/15 text-sky-400',
		imap: 'bg-gray-500/15 text-gray-400',
	};

	let searchTimeout: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => loadMessages(), 300);
	}

	onMount(() => {
		loadAccounts();
		loadMessages();
	});
</script>

<svelte:head>
	<title>Inbox — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<a href="/" class="text-hub-dim hover:text-hub-muted transition-colors">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
				</a>
				<div class="flex items-center gap-2">
					<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,7 12,13 2,7"/>
					</svg>
					<h1 class="text-lg font-bold text-hub-text">Inbox</h1>
				</div>
				<span class="text-xs text-hub-dim px-2 py-0.5 rounded bg-hub-surface">{stats.messages} emails</span>
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={() => { showAddForm = !showAddForm; }}
					class="px-3 py-1.5 rounded-lg border border-hub-border text-hub-muted text-sm hover:text-hub-text hover:border-hub-dim transition-colors cursor-pointer"
				>
					Add Account
				</button>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-hidden flex max-w-5xl mx-auto w-full">
		<!-- Sidebar: accounts + filters -->
		<aside class="w-56 flex-shrink-0 border-r border-hub-border p-3 overflow-y-auto hidden sm:block">
			<div class="mb-4">
				<input
					type="text"
					placeholder="Search emails..."
					bind:value={search}
					oninput={onSearchInput}
					class="w-full px-3 py-1.5 rounded-lg bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
				/>
			</div>

			<div class="mb-4">
				<p class="text-[10px] text-hub-dim uppercase tracking-wider mb-2 px-1">Accounts</p>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					onclick={() => { selectedAccount = null; loadMessages(); }}
					class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors {selectedAccount === null ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="text-xs">All accounts</span>
					<span class="ml-auto text-[10px] text-hub-dim">{stats.messages}</span>
				</div>
				{#each accounts as acc (acc.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => { selectedAccount = acc.id; loadMessages(); }}
						class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors group {selectedAccount === acc.id ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
					>
						<span class="text-[10px] px-1.5 py-0.5 rounded {providerColors[acc.provider] || providerColors.imap}">{acc.provider}</span>
						<span class="text-xs truncate flex-1">{acc.label}</span>
						<button
							onclick={(e) => { e.stopPropagation(); removeAccount(acc.id); }}
							class="hidden group-hover:block text-hub-dim hover:text-hub-danger text-xs cursor-pointer"
							aria-label="Remove account"
						>x</button>
					</div>
				{/each}

				{#if accounts.length === 0}
					<p class="text-xs text-hub-dim px-2 py-4">No accounts added yet. Click "Add Account" to connect your email.</p>
				{/if}
			</div>
		</aside>

		<!-- Message list -->
		<main class="flex-1 overflow-y-auto">
			{#if showAddForm}
				<div class="border-b border-hub-border p-4">
					<h2 class="text-sm font-medium text-hub-text mb-3">Add Email Account</h2>
					<div class="grid grid-cols-2 gap-3 max-w-md">
						<div>
							<label class="text-[10px] text-hub-dim uppercase tracking-wider">Provider</label>
							<select bind:value={addProvider} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text focus:outline-none">
								<option value="icloud">iCloud</option>
								<option value="gmail">Gmail</option>
								<option value="outlook">Outlook</option>
								<option value="imap">Custom IMAP</option>
							</select>
						</div>
						<div>
							<label class="text-[10px] text-hub-dim uppercase tracking-wider">Label (optional)</label>
							<input type="text" bind:value={addLabel} placeholder="Work, Personal..." class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
						</div>
						<div class="col-span-2">
							<label class="text-[10px] text-hub-dim uppercase tracking-wider">Email</label>
							<input type="email" bind:value={addEmail} placeholder="you@example.com" class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
						</div>
						<div class="col-span-2">
							<label class="text-[10px] text-hub-dim uppercase tracking-wider">
								{addProvider === 'icloud' ? 'App-Specific Password' : addProvider === 'gmail' ? 'App Password' : 'Password'}
							</label>
							<input type="password" bind:value={addPassword} placeholder="App-specific password" class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
							{#if addProvider === 'icloud'}
								<p class="text-[10px] text-hub-dim mt-1">Generate at appleid.apple.com > Sign-In and Security > App-Specific Passwords</p>
							{:else if addProvider === 'gmail'}
								<p class="text-[10px] text-hub-dim mt-1">Generate at myaccount.google.com > Security > 2-Step Verification > App passwords</p>
							{/if}
						</div>
					</div>
					{#if addError}
						<p class="text-xs text-hub-danger mt-2">{addError}</p>
					{/if}
					<div class="flex gap-2 mt-3">
						<button
							onclick={addAccount}
							disabled={adding}
							class="px-3 py-1.5 rounded-lg bg-hub-cta/15 text-hub-cta text-sm hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
						>
							{adding ? 'Adding...' : 'Add Account'}
						</button>
						<button
							onclick={() => { showAddForm = false; }}
							class="px-3 py-1.5 rounded-lg text-hub-dim text-sm hover:text-hub-muted transition-colors cursor-pointer"
						>
							Cancel
						</button>
					</div>
				</div>
			{/if}

			{#if loading}
				<div class="flex items-center justify-center py-12">
					<span class="text-sm text-hub-dim">Loading...</span>
				</div>
			{:else if messages.length === 0}
				<div class="flex flex-col items-center justify-center py-16 px-4">
					<svg class="w-12 h-12 text-hub-dim/30 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
						<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,7 12,13 2,7"/>
					</svg>
					<p class="text-sm text-hub-dim mb-1">No emails yet</p>
					<p class="text-xs text-hub-dim/60">Add an email account to start syncing</p>
				</div>
			{:else}
				<div class="divide-y divide-hub-border/50">
					{#each messages as msg (msg.id)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							onclick={() => { selectedMessage = selectedMessage?.id === msg.id ? null : msg; }}
							class="flex items-start gap-3 px-4 py-3 hover:bg-hub-surface/30 transition-colors cursor-pointer {!msg.flags.includes('\\Seen') ? 'bg-hub-surface/10' : ''}"
						>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-sm font-medium text-hub-text truncate {!msg.flags.includes('\\Seen') ? '' : 'font-normal text-hub-muted'}">{formatFrom(msg)}</span>
									{#if msg.hasAttachments}
										<svg class="w-3.5 h-3.5 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
									{/if}
									<span class="ml-auto text-[10px] text-hub-dim flex-shrink-0">
										{timeAgo(msg.dateSent ?? msg.dateReceived)}
									</span>
								</div>
								<p class="text-xs text-hub-text truncate {!msg.flags.includes('\\Seen') ? 'font-medium' : ''}">{msg.subject || '(no subject)'}</p>
								<p class="text-xs text-hub-dim truncate mt-0.5">{msg.bodyPreview || ''}</p>
							</div>
						</div>

						{#if selectedMessage?.id === msg.id}
							<div class="px-4 py-4 bg-hub-surface/20 border-b border-hub-border">
								<div class="flex items-start justify-between mb-2">
									<div>
										<p class="text-sm font-medium text-hub-text">{msg.subject || '(no subject)'}</p>
										<p class="text-xs text-hub-muted mt-0.5">
											From: {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
										</p>
										<p class="text-xs text-hub-dim">To: {msg.toAddress}</p>
									</div>
									<span class="text-[10px] text-hub-dim">
										{new Date(msg.dateSent ?? msg.dateReceived).toLocaleString()}
									</span>
								</div>
								<div class="mt-3 text-xs text-hub-muted whitespace-pre-wrap leading-relaxed">
									{msg.bodyPreview || '(no preview available)'}
								</div>
							</div>
						{/if}
					{/each}
				</div>

				{#if total > messages.length}
					<div class="px-4 py-3 text-center">
						<span class="text-xs text-hub-dim">Showing {messages.length} of {total} emails</span>
					</div>
				{/if}
			{/if}
		</main>
	</div>
</div>
