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
	let loadingMore = $state(false);
	let search = $state('');
	let selectedAccount = $state<string | null>(null);
	let selectedMessage = $state<Message | null>(null);
	let showSidebar = $state(false);
	let offset = $state(0);
	const PAGE_SIZE = 50;
	let stats = $state<{ accounts: number; messages: number; lastSync: number | null }>({ accounts: 0, messages: 0, lastSync: null });

	// Add account form
	let showAddForm = $state(false);
	let addProvider = $state('icloud');
	let addEmail = $state('');
	let addPassword = $state('');
	let addLabel = $state('');
	let addError = $state('');
	let adding = $state(false);

	// URL params feedback
	let flashMessage = $state('');

	const statusColors: Record<string, string> = {
		connected: 'bg-emerald-400',
		syncing: 'bg-amber-400 animate-pulse',
		error: 'bg-hub-danger',
		disconnected: 'bg-hub-dim/50',
	};

	const providerColors: Record<string, string> = {
		icloud: 'bg-blue-500/15 text-blue-400',
		gmail: 'bg-red-500/15 text-red-400',
		outlook: 'bg-sky-500/15 text-sky-400',
		imap: 'bg-gray-500/15 text-gray-400',
	};

	async function loadAccounts() {
		try {
			const res = await fetch('/api/inbox/accounts');
			if (res.ok) {
				const data = await res.json();
				accounts = data.accounts ?? [];
			}
		} catch { /* silent */ }
	}

	async function loadMessages(append = false) {
		if (append) { loadingMore = true; } else { loading = true; offset = 0; }
		try {
			const params = new URLSearchParams();
			if (selectedAccount) params.set('account', selectedAccount);
			if (search) params.set('search', search);
			params.set('limit', String(PAGE_SIZE));
			params.set('offset', String(append ? offset : 0));

			const res = await fetch(`/api/inbox/messages?${params}`);
			if (res.ok) {
				const data = await res.json();
				if (append) {
					messages = [...messages, ...(data.messages ?? [])];
				} else {
					messages = data.messages ?? [];
				}
				total = data.total ?? 0;
				stats = data.stats ?? stats;
				if (append) offset += PAGE_SIZE;
				else offset = PAGE_SIZE;
			}
		} catch { /* silent */ }
		loading = false;
		loadingMore = false;
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
		} catch {
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
			if (selectedAccount === id) selectedAccount = null;
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

	function getAccountLabel(accountId: string): string {
		const acc = accounts.find(a => a.id === accountId);
		return acc?.provider || '';
	}

	let searchTimeout: ReturnType<typeof setTimeout>;
	function onSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => loadMessages(), 300);
	}

	function clearSearch() {
		search = '';
		loadMessages();
	}

	onMount(() => {
		// Handle URL params (from OAuth callbacks)
		const urlParams = new URLSearchParams(window.location.search);
		const added = urlParams.get('added');
		const error = urlParams.get('error');
		if (added) {
			flashMessage = `${added} account connected successfully`;
			setTimeout(() => { flashMessage = ''; }, 5000);
			// Clean URL
			window.history.replaceState({}, '', '/inbox');
		}
		if (error) {
			flashMessage = `Error: ${decodeURIComponent(error)}`;
			setTimeout(() => { flashMessage = ''; }, 8000);
			window.history.replaceState({}, '', '/inbox');
		}

		loadAccounts();
		loadMessages();

		// Refresh accounts periodically to see status changes
		const refreshInterval = setInterval(loadAccounts, 15000);
		return () => clearInterval(refreshInterval);
	});
</script>

<svelte:head>
	<title>Inbox — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Flash message -->
	{#if flashMessage}
		<div class="px-4 py-2 text-sm text-center {flashMessage.startsWith('Error') ? 'bg-hub-danger/10 text-hub-danger' : 'bg-emerald-500/10 text-emerald-400'}">
			{flashMessage}
		</div>
	{/if}

	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<a href="/" class="text-hub-dim hover:text-hub-muted transition-colors">
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
				</a>
				<!-- Mobile sidebar toggle -->
				<button
					onclick={() => { showSidebar = !showSidebar; }}
					class="sm:hidden p-1 rounded text-hub-dim hover:text-hub-muted cursor-pointer"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
				</button>
				<div class="flex items-center gap-2">
					<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,7 12,13 2,7"/>
					</svg>
					<h1 class="text-lg font-bold text-hub-text">Inbox</h1>
				</div>
				{#if stats.messages > 0}
					<span class="text-xs text-hub-dim px-2 py-0.5 rounded bg-hub-surface">{stats.messages} emails</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if stats.lastSync}
					<span class="hidden sm:inline text-[10px] text-hub-dim">synced {timeAgo(stats.lastSync)}</span>
				{/if}
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
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		{#if showSidebar}
			<div onclick={() => { showSidebar = false; }} class="fixed inset-0 bg-black/30 z-10 sm:hidden"></div>
		{/if}
		<aside class="w-56 flex-shrink-0 border-r border-hub-border p-3 overflow-y-auto {showSidebar ? 'fixed inset-y-0 left-0 z-20 bg-hub-bg' : 'hidden'} sm:block sm:static sm:z-auto">
			<!-- Search -->
			<div class="mb-4 relative">
				<input
					type="text"
					placeholder="Search emails..."
					bind:value={search}
					oninput={onSearchInput}
					class="w-full px-3 py-1.5 rounded-lg bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 {search ? 'pr-7' : ''}"
				/>
				{#if search}
					<button
						onclick={clearSearch}
						class="absolute right-2 top-1/2 -translate-y-1/2 text-hub-dim hover:text-hub-muted cursor-pointer"
					>
						<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
					</button>
				{/if}
			</div>

			<!-- Account list -->
			<div class="mb-4">
				<p class="text-[10px] text-hub-dim uppercase tracking-wider mb-2 px-1">Accounts</p>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					onclick={() => { selectedAccount = null; loadMessages(); showSidebar = false; }}
					class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors {selectedAccount === null ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="text-xs">All accounts</span>
					<span class="ml-auto text-[10px] text-hub-dim">{stats.messages}</span>
				</div>
				{#each accounts as acc (acc.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => { selectedAccount = acc.id; loadMessages(); showSidebar = false; }}
						class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors group {selectedAccount === acc.id ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
					>
						<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {statusColors[acc.status] || statusColors.disconnected}" title={acc.status}></span>
						<span class="text-[10px] px-1.5 py-0.5 rounded {providerColors[acc.provider] || providerColors.imap}">{acc.provider}</span>
						<span class="text-xs truncate flex-1" title={acc.email}>{acc.label}</span>
						<button
							onclick={(e) => { e.stopPropagation(); removeAccount(acc.id); }}
							class="hidden group-hover:block text-hub-dim hover:text-hub-danger text-xs cursor-pointer"
							aria-label="Remove account"
						>x</button>
					</div>
					{#if acc.status === 'error' && acc.lastError}
						<p class="text-[10px] text-hub-danger/70 px-6 -mt-0.5 mb-1 truncate" title={acc.lastError}>{acc.lastError}</p>
					{/if}
				{/each}

				{#if accounts.length === 0}
					<p class="text-xs text-hub-dim px-2 py-4">No accounts yet. Click "Add Account" to connect.</p>
				{/if}
			</div>
		</aside>

		<!-- Message list -->
		<main class="flex-1 overflow-y-auto">
			<!-- Mobile search bar -->
			<div class="sm:hidden border-b border-hub-border px-4 py-2">
				<div class="relative">
					<input
						type="text"
						placeholder="Search..."
						bind:value={search}
						oninput={onSearchInput}
						class="w-full px-3 py-1.5 rounded-lg bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
					/>
					{#if search}
						<button onclick={clearSearch} class="absolute right-2 top-1/2 -translate-y-1/2 text-hub-dim hover:text-hub-muted cursor-pointer">
							<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
						</button>
					{/if}
				</div>
			</div>

			{#if search}
				<div class="px-4 py-2 border-b border-hub-border/50 bg-hub-surface/20 flex items-center justify-between">
					<span class="text-xs text-hub-muted">{total} result{total === 1 ? '' : 's'} for "{search}"</span>
					<button onclick={clearSearch} class="text-xs text-hub-dim hover:text-hub-muted cursor-pointer">Clear</button>
				</div>
			{/if}

			{#if showAddForm}
				<div class="border-b border-hub-border p-4">
					<h2 class="text-sm font-medium text-hub-text mb-3">Add Email Account</h2>
					<div class="grid grid-cols-2 gap-3 max-w-md">
						<div class="col-span-2">
							<label class="text-[10px] text-hub-dim uppercase tracking-wider">Provider</label>
							<select bind:value={addProvider} class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text focus:outline-none">
								<option value="icloud">iCloud</option>
								<option value="gmail">Gmail (OAuth2)</option>
								<option value="outlook">Outlook (OAuth2)</option>
								<option value="imap">Custom IMAP</option>
							</select>
						</div>

						{#if addProvider === 'gmail'}
							<div class="col-span-2">
								<p class="text-xs text-hub-muted mb-3">Gmail uses secure OAuth2 authentication.</p>
								<a href="/api/inbox/oauth" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/15 text-red-400 text-sm font-medium hover:bg-red-500/25 transition-colors">
									<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 110-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.969 9.969 0 0012.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748l-9.426-.013z"/></svg>
									Sign in with Google
								</a>
							</div>
						{:else if addProvider === 'outlook'}
							<div class="col-span-2">
								<p class="text-xs text-hub-muted mb-3">Outlook uses secure OAuth2 authentication.</p>
								<a href="/api/inbox/outlook" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500/15 text-sky-400 text-sm font-medium hover:bg-sky-500/25 transition-colors">
									<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z"/></svg>
									Sign in with Microsoft
								</a>
							</div>
						{:else}
							<div>
								<label class="text-[10px] text-hub-dim uppercase tracking-wider">Label (optional)</label>
								<input type="text" bind:value={addLabel} placeholder="Work, Personal..." class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
							</div>
							<div>
								<label class="text-[10px] text-hub-dim uppercase tracking-wider">Email</label>
								<input type="email" bind:value={addEmail} placeholder="you@example.com" class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
							</div>
							<div class="col-span-2">
								<label class="text-[10px] text-hub-dim uppercase tracking-wider">
									{addProvider === 'icloud' ? 'App-Specific Password' : 'Password'}
								</label>
								<input type="password" bind:value={addPassword} placeholder="App-specific password" class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
								{#if addProvider === 'icloud'}
									<p class="text-[10px] text-hub-dim mt-1">Generate at appleid.apple.com > Sign-In and Security > App-Specific Passwords</p>
								{/if}
							</div>
						{/if}
					</div>
					{#if addError}
						<p class="text-xs text-hub-danger mt-2">{addError}</p>
					{/if}
					<div class="flex gap-2 mt-3">
						{#if addProvider !== 'gmail' && addProvider !== 'outlook'}
							<button
								onclick={addAccount}
								disabled={adding}
								class="px-3 py-1.5 rounded-lg bg-hub-cta/15 text-hub-cta text-sm hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
							>
								{adding ? 'Adding...' : 'Add Account'}
							</button>
						{/if}
						<button onclick={() => { showAddForm = false; }} class="px-3 py-1.5 rounded-lg text-hub-dim text-sm hover:text-hub-muted transition-colors cursor-pointer">
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
					{#if search}
						<p class="text-sm text-hub-dim mb-1">No results for "{search}"</p>
						<button onclick={clearSearch} class="text-xs text-hub-cta hover:underline cursor-pointer mt-1">Clear search</button>
					{:else if accounts.length === 0}
						<p class="text-sm text-hub-dim mb-1">No email accounts connected</p>
						<p class="text-xs text-hub-dim/60">Click "Add Account" to get started</p>
					{:else}
						<p class="text-sm text-hub-dim mb-1">No emails yet</p>
						<p class="text-xs text-hub-dim/60">Emails will appear here as they sync</p>
					{/if}
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
									{#if !msg.flags.includes('\\Seen')}
										<span class="w-1.5 h-1.5 rounded-full bg-hub-cta flex-shrink-0"></span>
									{/if}
									<span class="text-sm text-hub-text truncate {!msg.flags.includes('\\Seen') ? 'font-medium' : 'text-hub-muted'}">{formatFrom(msg)}</span>
									{#if !selectedAccount && accounts.length > 1}
										<span class="text-[9px] px-1 py-0.5 rounded {providerColors[getAccountLabel(msg.accountId)] || 'bg-hub-surface text-hub-dim'}">{getAccountLabel(msg.accountId)}</span>
									{/if}
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
									<div class="min-w-0 flex-1">
										<p class="text-sm font-medium text-hub-text">{msg.subject || '(no subject)'}</p>
										<p class="text-xs text-hub-muted mt-0.5">
											From: {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
										</p>
										<p class="text-xs text-hub-dim">To: {msg.toAddress}</p>
									</div>
									<span class="text-[10px] text-hub-dim flex-shrink-0 ml-2">
										{new Date(msg.dateSent ?? msg.dateReceived).toLocaleString()}
									</span>
								</div>
								<div class="mt-3 text-xs text-hub-muted whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
									{msg.bodyPreview || '(no preview available — full body loads when sync fetches it)'}
								</div>
							</div>
						{/if}
					{/each}
				</div>

				{#if total > messages.length}
					<div class="px-4 py-3 text-center border-t border-hub-border/30">
						<button
							onclick={() => loadMessages(true)}
							disabled={loadingMore}
							class="text-xs text-hub-cta hover:text-hub-text transition-colors cursor-pointer disabled:opacity-50"
						>
							{loadingMore ? 'Loading...' : `Load more (${messages.length} of ${total})`}
						</button>
					</div>
				{/if}
			{/if}
		</main>
	</div>
</div>
