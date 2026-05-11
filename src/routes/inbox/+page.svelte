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
		retentionDays: number;
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
		attachmentCount: number;
		processStatus: string;
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

	// Account settings modal
	let settingsAccount = $state<Account | null>(null);
	let settingsLabel = $state('');
	let settingsRetention = $state(90);
	let settingsSaving = $state(false);

	// Reset password / Reauthorize section
	let resetOpen = $state(false);
	let resetPassword = $state('');
	let resetSaving = $state(false);
	let resetError = $state('');
	let resetSuccess = $state('');
	const isOAuthAccount = $derived(
		settingsAccount?.provider === 'gmail' || settingsAccount?.provider === 'outlook',
	);

	interface ProviderHelp {
		label: string;
		url: string;
		hint: string;
	}

	const providerHelp: Record<string, ProviderHelp> = {
		icloud: {
			label: 'Apple ID — App-Specific Passwords',
			url: 'https://account.apple.com/account/manage',
			hint: 'Sign in → Sign-In and Security → App-Specific Passwords → Generate. Requires two-factor authentication.',
		},
		gmail: {
			label: 'Google Account — Third-party access',
			url: 'https://myaccount.google.com/permissions',
			hint: 'Gmail uses OAuth2. If sync stops working (Google\'s Testing-mode refresh tokens expire after 7 days), click Reauthorize below to re-grant access. You can also revoke access at any time from your Google Account.',
		},
		outlook: {
			label: 'Microsoft — App passwords',
			url: 'https://account.microsoft.com/security',
			hint: 'Advanced security options → App passwords → Create a new app password.',
		},
		imap: {
			label: 'IMAP credential',
			url: '',
			hint: 'Use the password (or app-specific password) provided by your mail host.',
		},
	};

	// Status filter
	let statusFilter = $state('');
	const processStatusFilters = [
		{ value: '', label: 'All' },
		{ value: 'new', label: 'New' },
		{ value: 'queued', label: 'Queued' },
		{ value: 'processed', label: 'Processed' },
		{ value: 'skipped', label: 'Skipped' },
	];

	const processStatusColors: Record<string, string> = {
		new: 'bg-blue-400',
		queued: 'bg-amber-400',
		processed: 'bg-emerald-400',
		skipped: 'bg-hub-dim/50',
	};

	// Add account form
	let showAddForm = $state(false);
	let addProvider = $state('icloud');
	let addEmail = $state('');
	let addPassword = $state('');
	let addLabel = $state('');
	let addError = $state('');
	let adding = $state(false);
	const addHelp = $derived(providerHelp[addProvider] ?? providerHelp.imap);

	// URL params feedback
	let flashMessage = $state('');
	let flashType = $state<'success' | 'error'>('success');
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	function showFlash(message: string, type: 'success' | 'error', ms: number) {
		if (flashTimer) clearTimeout(flashTimer);
		flashMessage = message;
		flashType = type;
		flashTimer = setTimeout(() => { flashMessage = ''; flashTimer = null; }, ms);
	}

	// Origin for redirect-URI display in Gmail setup hint (client-only).
	let currentOrigin = $state('');

	// Gmail OAuth configuration status — populated when the Add form opens
	// and the Gmail provider is selected. Drives the branch between
	// "Configure in Settings" and "Sign in with Google".
	let gmailConfigured = $state<boolean | null>(null); // null = not yet checked
	let gmailConfigChecking = $state(false);

	async function checkGmailConfig() {
		gmailConfigChecking = true;
		try {
			const res = await fetch('/api/inbox/oauth/status');
			if (res.ok) {
				const data = await res.json();
				gmailConfigured = Boolean(data.configured);
				if (data.redirectUri) currentOrigin = new URL(data.redirectUri).origin;
			}
		} catch {
			gmailConfigured = false;
		}
		gmailConfigChecking = false;
	}

	$effect(() => {
		if (showAddForm && addProvider === 'gmail') {
			checkGmailConfig();
		}
	});

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
			if (statusFilter) params.set('status', statusFilter);
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

	function openAccountSettings(acc: Account, e: MouseEvent) {
		e.stopPropagation();
		settingsAccount = acc;
		settingsLabel = acc.label;
		settingsRetention = acc.retentionDays;
		resetOpen = false;
		resetPassword = '';
		resetError = '';
		resetSuccess = '';
	}

	async function saveAccountSettings() {
		if (!settingsAccount) return;
		settingsSaving = true;
		try {
			const res = await fetch('/api/inbox/accounts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: settingsAccount.id,
					label: settingsLabel,
					retentionDays: settingsRetention,
				}),
			});
			if (res.ok) {
				await loadAccounts();
				settingsAccount = null;
			}
		} catch { /* silent */ }
		settingsSaving = false;
	}

	async function resetAccountPassword() {
		if (!settingsAccount) return;
		resetError = '';
		resetSuccess = '';
		if (!resetPassword.trim()) {
			resetError = 'Password is required';
			return;
		}
		resetSaving = true;
		try {
			const res = await fetch('/api/inbox/accounts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: settingsAccount.id,
					credential: resetPassword.trim(),
				}),
			});
			const data = await res.json();
			if (res.ok) {
				resetSuccess = 'Password updated — reconnecting…';
				resetPassword = '';
				await loadAccounts();
			} else {
				resetError = data.error || 'Failed to update password';
			}
		} catch {
			resetError = 'Network error';
		}
		resetSaving = false;
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
		currentOrigin = window.location.origin;
		// Handle URL params (from OAuth callbacks). Error wins over success
		// when multiple flags arrive on the same redirect, and only one
		// timer ever runs (see showFlash).
		const urlParams = new URLSearchParams(window.location.search);
		const added = urlParams.get('added');
		const reauthorized = urlParams.get('reauthorized');
		const error = urlParams.get('error');
		if (error) {
			showFlash(`Error: ${decodeURIComponent(error)}`, 'error', 8000);
			window.history.replaceState({}, '', '/inbox');
		} else if (reauthorized) {
			showFlash(`Reauthorized ${decodeURIComponent(reauthorized)} — reconnecting…`, 'success', 5000);
			window.history.replaceState({}, '', '/inbox');
		} else if (added) {
			showFlash(`${added} account connected successfully`, 'success', 5000);
			window.history.replaceState({}, '', '/inbox');
		}

		loadAccounts();
		loadMessages();

		// Refresh accounts periodically to see status changes
		const refreshInterval = setInterval(loadAccounts, 15000);
		return () => {
			clearInterval(refreshInterval);
			if (flashTimer) clearTimeout(flashTimer);
		};
	});
</script>

<svelte:head>
	<title>Inbox — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Flash message -->
	{#if flashMessage}
		<div class="px-4 py-2 text-sm text-center {flashType === 'error' ? 'bg-hub-danger/10 text-hub-danger' : 'bg-emerald-500/10 text-emerald-400'}">
			{flashMessage}
		</div>
	{/if}

	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
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
							onclick={(e) => { openAccountSettings(acc, e); }}
							class="hidden group-hover:block text-hub-dim hover:text-hub-muted cursor-pointer"
							aria-label="Account settings"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
						</button>
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

			<!-- Status filter -->
			<div>
				<p class="text-[10px] text-hub-dim uppercase tracking-wider mb-2 px-1">Status</p>
				{#each processStatusFilters as filter (filter.value)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onclick={() => { statusFilter = filter.value; loadMessages(); }}
						class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors {statusFilter === filter.value ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
					>
						{#if filter.value}
							<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {processStatusColors[filter.value] || 'bg-hub-dim/50'}"></span>
						{/if}
						<span class="text-xs">{filter.label}</span>
					</div>
				{/each}
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
							<div class="col-span-2 space-y-3">
								<p class="text-xs text-hub-muted">Gmail uses secure OAuth2 authentication.</p>

								<!-- One-time Google Cloud Console setup. The cred values themselves
								     are managed in Settings (Platform Environment) — this drawer
								     only covers steps Soul Hub can't automate (creating the GCP
								     project and OAuth client). -->
								<details class="rounded-md bg-hub-surface/60 border border-hub-border/60">
									<summary class="px-3 py-2 text-[11px] text-hub-muted hover:text-hub-text transition-colors cursor-pointer list-none flex items-center justify-between">
										<span>First time? Set up the Google OAuth client</span>
										<svg class="w-3 h-3 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<polyline points="6 9 12 15 18 9"/>
										</svg>
									</summary>
									<div class="px-3 pb-3 text-[11px] text-hub-muted leading-relaxed space-y-2 border-t border-hub-border/40 pt-2">
										<p>In <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer" class="text-hub-cta hover:underline">Google Cloud Console</a>:</p>
										<ol class="list-decimal ms-4 space-y-1">
											<li>Create a project → enable the <span class="font-mono">Gmail API</span>.</li>
											<li>Configure the <span class="font-mono">OAuth consent screen</span> as External, leave it in <strong>Testing</strong> mode, add yourself as a test user. Scopes: <span class="font-mono">openid</span>, <span class="font-mono">userinfo.email</span>, <span class="font-mono">https://mail.google.com/</span>.</li>
											<li>Credentials → <span class="font-mono">Create OAuth client ID</span> → Web application. Add this authorized redirect URI:
												<code class="block mt-1 px-2 py-1 rounded bg-hub-bg/60 border border-hub-border/40 text-[10px] text-hub-text break-all select-all">{currentOrigin ? `${currentOrigin}/api/inbox/oauth/callback` : '<this app>/api/inbox/oauth/callback'}</code>
											</li>
											<li>Copy the resulting <strong>Client ID</strong> and <strong>Client Secret</strong> into <a href="/settings" class="text-hub-cta hover:underline">Settings → Platform Environment</a> (fields <span class="font-mono">GOOGLE_CLIENT_ID</span> and <span class="font-mono">GOOGLE_CLIENT_SECRET</span>). They take effect immediately — no restart needed.</li>
										</ol>
										<p class="text-[10px] text-hub-dim pt-1">Heads-up: Google's Testing-mode refresh tokens expire every 7 days. If sync stops, use <em>Reauthorize</em> in the account settings to re-grant access.</p>
									</div>
								</details>

								{#if gmailConfigChecking || gmailConfigured === null}
									<div class="text-[11px] text-hub-dim">Checking Gmail OAuth configuration…</div>
								{:else if !gmailConfigured}
									<div class="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 space-y-2">
										<p class="text-[11px] text-amber-300">
											Gmail OAuth isn't configured yet. Add <span class="font-mono">GOOGLE_CLIENT_ID</span> and <span class="font-mono">GOOGLE_CLIENT_SECRET</span> in Settings to enable Sign in with Google.
										</p>
										<a href="/settings#platform-env" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 text-xs font-medium hover:bg-amber-500/25 transition-colors">
											Configure in Settings
											<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H8M17 7v9"/></svg>
										</a>
									</div>
								{:else}
									<a href="/api/inbox/oauth" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/15 text-red-400 text-sm font-medium hover:bg-red-500/25 transition-colors">
										<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 110-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.969 9.969 0 0012.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748l-9.426-.013z"/></svg>
										Sign in with Google
									</a>
								{/if}
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
								<p class="text-[10px] text-hub-dim mt-1 leading-relaxed">
									{addHelp.hint}
									{#if addHelp.url}
										<a href={addHelp.url} target="_blank" rel="noopener noreferrer" class="text-hub-cta hover:underline ms-1">
											Open {addHelp.label.split(' — ')[0]} ↗
										</a>
									{/if}
								</p>
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
									{#if msg.attachmentCount > 0}
										<span class="flex items-center gap-0.5 text-[10px] text-hub-dim flex-shrink-0" title="{msg.attachmentCount} attachment{msg.attachmentCount === 1 ? '' : 's'}">
											<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
											{msg.attachmentCount}
										</span>
									{:else if msg.hasAttachments}
										<svg class="w-3.5 h-3.5 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
									{/if}
									{#if msg.processStatus && processStatusColors[msg.processStatus]}
										<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {processStatusColors[msg.processStatus]}" title="Status: {msg.processStatus}"></span>
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

	<!-- Account Settings Modal -->
	{#if settingsAccount}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div onclick={() => { settingsAccount = null; }} class="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4">
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div onclick={(e) => e.stopPropagation()} class="bg-hub-card border border-hub-border rounded-xl w-full max-w-sm p-5 shadow-xl">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-sm font-medium text-hub-text">Account Settings</h2>
					<button onclick={() => { settingsAccount = null; }} class="text-hub-dim hover:text-hub-muted cursor-pointer">
						<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
					</button>
				</div>

				<!-- Provider & Email (read-only) -->
				<div class="mb-4 flex items-center gap-2">
					<span class="w-2 h-2 rounded-full flex-shrink-0 {statusColors[settingsAccount.status] || statusColors.disconnected}"></span>
					<span class="text-[10px] px-1.5 py-0.5 rounded {providerColors[settingsAccount.provider] || providerColors.imap}">{settingsAccount.provider}</span>
					<span class="text-xs text-hub-muted truncate">{settingsAccount.email}</span>
				</div>

				{#if settingsAccount.lastSync}
					<p class="text-[10px] text-hub-dim mb-4">Last synced {timeAgo(settingsAccount.lastSync)} ago</p>
				{/if}

				<!-- Label -->
				<div class="mb-4">
					<label class="text-[10px] text-hub-dim uppercase tracking-wider">Label</label>
					<input
						type="text"
						bind:value={settingsLabel}
						class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text focus:outline-none focus:border-hub-cta/50"
					/>
				</div>

				<!-- Retention -->
				<div class="mb-5">
					<label class="text-[10px] text-hub-dim uppercase tracking-wider">Retention</label>
					<div class="flex items-center gap-3 mt-1">
						<input
							type="range"
							min="1"
							max="365"
							bind:value={settingsRetention}
							class="flex-1 accent-hub-cta"
						/>
						<div class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="365"
								bind:value={settingsRetention}
								class="w-14 px-1.5 py-1 rounded bg-hub-surface border border-hub-border text-xs text-hub-text text-center focus:outline-none focus:border-hub-cta/50"
							/>
							<span class="text-[10px] text-hub-dim">days</span>
						</div>
					</div>
				</div>

				<!-- Reset Password / Reauthorize -->
				<div class="mb-5 border-t border-hub-border/60 pt-4">
					<button
						type="button"
						onclick={() => { resetOpen = !resetOpen; resetError = ''; resetSuccess = ''; }}
						class="flex items-center justify-between w-full text-left cursor-pointer group"
					>
						<span class="text-[10px] text-hub-dim uppercase tracking-wider group-hover:text-hub-muted transition-colors">
							{isOAuthAccount ? 'Reauthorize' : 'Reset password'}
						</span>
						<svg
							class="w-3 h-3 text-hub-dim group-hover:text-hub-muted transition-transform {resetOpen ? 'rotate-180' : ''}"
							viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						>
							<polyline points="6 9 12 15 18 9"/>
						</svg>
					</button>

					{#if resetOpen}
						{@const help = providerHelp[settingsAccount.provider] ?? providerHelp.imap}
						<div class="mt-3 space-y-3">
							<!-- Provider-specific instructions -->
							<div class="rounded-md bg-hub-surface/60 border border-hub-border/60 px-3 py-2.5">
								<p class="text-[11px] text-hub-muted leading-relaxed">
									{help.hint}
								</p>
								{#if help.url}
									<a
										href={help.url}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center gap-1 mt-2 text-[11px] text-hub-cta hover:underline"
									>
										{help.label}
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M7 17L17 7M17 7H8M17 7v9"/>
										</svg>
									</a>
								{/if}
							</div>

							{#if isOAuthAccount && settingsAccount.provider === 'gmail'}
								<!-- Gmail OAuth re-link: redirect to Google consent flow -->
								<a
									href={`/api/inbox/oauth?account=${settingsAccount.id}`}
									class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/15 text-red-400 text-xs font-medium hover:bg-red-500/25 transition-colors"
								>
									<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 110-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.969 9.969 0 0012.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748l-9.426-.013z"/></svg>
									Reauthorize with Google
								</a>
							{:else if isOAuthAccount && settingsAccount.provider === 'outlook'}
								<!-- Outlook in-place reauthorize isn't wired yet (inbox-plan Open #2).
								     Direct the operator at the only working recovery: remove + re-add. -->
								<div class="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 space-y-2">
									<p class="text-[11px] text-amber-300 leading-relaxed">
										In-place Outlook reauthorize isn't wired yet. To recover this account, remove it below and re-add via <span class="font-medium">Add Account → Outlook → Sign in with Microsoft</span>. Tracked in the inbox plan.
									</p>
									<button
										onclick={() => { if (settingsAccount) { const id = settingsAccount.id; settingsAccount = null; removeAccount(id); } }}
										class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 text-xs font-medium hover:bg-amber-500/25 transition-colors cursor-pointer"
									>
										Remove this account
									</button>
								</div>
							{:else}
								<!-- Password-based providers: in-place credential update -->
								<input
									type="password"
									bind:value={resetPassword}
									placeholder="New app-specific password"
									autocomplete="new-password"
									spellcheck="false"
									class="w-full px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text focus:outline-none focus:border-hub-cta/50 font-mono"
								/>

								{#if resetError}
									<p class="text-[11px] text-hub-danger">{resetError}</p>
								{/if}
								{#if resetSuccess}
									<p class="text-[11px] text-emerald-400">{resetSuccess}</p>
								{/if}

								<button
									onclick={resetAccountPassword}
									disabled={resetSaving || !resetPassword.trim()}
									class="px-3 py-1.5 rounded-lg bg-hub-cta/15 text-hub-cta text-xs hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									{resetSaving ? 'Updating…' : 'Update password & reconnect'}
								</button>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Actions -->
				<div class="flex gap-2">
					<button
						onclick={saveAccountSettings}
						disabled={settingsSaving}
						class="px-4 py-1.5 rounded-lg bg-hub-cta/15 text-hub-cta text-sm hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
					>
						{settingsSaving ? 'Saving...' : 'Save'}
					</button>
					<button onclick={() => { settingsAccount = null; }} class="px-3 py-1.5 rounded-lg text-hub-dim text-sm hover:text-hub-muted transition-colors cursor-pointer">
						Cancel
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
