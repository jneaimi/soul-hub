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

	interface AttachmentMeta {
		filename: string;
		size: number;
		mimeType: string;
		part?: string;
		isInline: boolean;
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
		attachmentsMeta: AttachmentMeta[];
		processStatus: string;
		bodyPreview: string;
	}

	interface MessageBody {
		text: string;
		html: string | null;
		fetchedAt: number;
	}

	let accounts = $state<Account[]>([]);
	let messages = $state<Message[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	let search = $state('');
	let selectedAccount = $state<string | null>(null);
	let selectedMessage = $state<Message | null>(null);
	// Accounts whose lastError is expanded in the sidebar. Single-id slot —
	// only one error is expanded at a time, keeps the sidebar compact.
	let expandedErrorId = $state<string | null>(null);

	// Full-message-body cache keyed by message id. Populated lazily on row
	// expand via GET /api/inbox/messages/[id]/body — see ADR 2026-04-16 and
	// plan Open #3. Kept in component state for the current session;
	// refresh re-fetches on next expand.
	let bodyCache = $state<Map<number, MessageBody>>(new Map());
	let bodyLoading = $state(false);
	let bodyError = $state<string | null>(null);
	let viewHtml = $state(false); // per-selection toggle, resets on each open

	// Focus targets for first-input-focus on modal/drawer open.
	let settingsLabelInput: HTMLInputElement | undefined = $state();
	let addEmailInput: HTMLInputElement | undefined = $state();
	let showSidebar = $state(false);
	let offset = $state(0);
	const PAGE_SIZE = 50;
	let stats = $state<{ accounts: number; messages: number; lastSync: number | null }>({ accounts: 0, messages: 0, lastSync: null });

	// Account settings modal
	let settingsAccount = $state<Account | null>(null);
	let settingsLabel = $state('');
	let settingsRetention = $state(90);
	// keepForever = "never delete" toggle (sentinel value is retentionDays=0;
	// pruneOldMessages already short-circuits on <= 0). When toggled on, the
	// slider stays at its last numeric value so unchecking restores cleanly.
	let keepForever = $state(false);
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

	// Process-status colors. queued was bg-amber-400 originally but collided
	// with the syncing account-status dot (also amber-400) on the same screen
	// — two semantically different states sharing a color. Moved queued to
	// emerald-300 so it sits in the same family as `processed` (both are
	// "signal-confirmed for agents") while staying visually distinct.
	const processStatusColors: Record<string, string> = {
		new: 'bg-blue-400',
		queued: 'bg-emerald-300',
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

	// Count of already-connected accounts per provider. Drives the
	// "Sign in / Add another" copy branch in the Add panel for OAuth
	// providers, and a "you already have N {provider} accounts" hint
	// for password providers (iCloud, custom IMAP). Signals that the
	// flow supports multiple identities per provider. See ADR
	// 2026-05-11-multiple-gmail-accounts.
	const existingGmailCount = $derived(
		accounts.filter((a) => a.provider === 'gmail').length,
	);
	const existingOutlookCount = $derived(
		accounts.filter((a) => a.provider === 'outlook').length,
	);
	const existingProviderCount = $derived(
		accounts.filter((a) => a.provider === addProvider).length,
	);

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

	// First-input focus on overlay open. requestAnimationFrame waits for the
	// node to mount; without it the bind:this reference may still be undefined.
	$effect(() => {
		if (settingsAccount && settingsLabelInput) {
			requestAnimationFrame(() => settingsLabelInput?.focus());
		}
	});
	$effect(() => {
		// Only focus the email field for password providers — OAuth providers
		// render a single CTA button instead.
		if (showAddForm && (addProvider === 'icloud' || addProvider === 'imap') && addEmailInput) {
			requestAnimationFrame(() => addEmailInput?.focus());
		}
	});

	// Keyboard equivalence for rows that must remain <div> because they
	// contain nested interactive children (gear/x buttons). Enter/Space
	// triggers the same handler as click.
	function onRowKey(e: KeyboardEvent, handler: () => void) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handler();
		}
	}

	// Lazy body loader. When a message is expanded, fetch its full body
	// from /api/inbox/messages/[id]/body unless we've already cached it
	// in this session. Resets the HTML-view toggle on every new selection
	// so each open starts on the safer text view.
	async function loadMessageBody(id: number) {
		bodyError = null;
		if (bodyCache.has(id)) return;
		bodyLoading = true;
		try {
			const res = await fetch(`/api/inbox/messages/${id}/body`);
			const data = await res.json();
			if (res.ok) {
				const next = new Map(bodyCache);
				next.set(id, data as MessageBody);
				bodyCache = next;
			} else {
				bodyError = data.error || `HTTP ${res.status}`;
			}
		} catch (err) {
			bodyError = (err as Error).message || 'Network error';
		}
		bodyLoading = false;
	}

	$effect(() => {
		if (selectedMessage) {
			viewHtml = false;
			void loadMessageBody(selectedMessage.id);
		}
	});

	// Track active-filter state to the URL. Reads happen once on mount
	// (below); after that this effect keeps the URL in sync as the operator
	// changes filters or types into the search box.
	$effect(() => {
		// Read each reactive slot so $effect tracks them.
		selectedAccount;
		statusFilter;
		search;
		syncUrl();
	});

	// Escape closes whichever overlay is open, top-down by visual stacking
	// (modal > drawer > mobile sidebar). Only one runs per press.
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (settingsAccount) {
			settingsAccount = null;
		} else if (showAddForm) {
			showAddForm = false;
		} else if (showSidebar) {
			showSidebar = false;
		}
	}

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
		// Seed both retention slots: if the account is "never delete" (0),
		// keepForever=true and the slider defaults to 90 so unchecking the
		// checkbox restores to a sensible value rather than the 0 sentinel.
		if (acc.retentionDays === 0) {
			keepForever = true;
			settingsRetention = 90;
		} else {
			keepForever = false;
			settingsRetention = acc.retentionDays;
		}
		resetOpen = false;
		resetPassword = '';
		resetError = '';
		resetSuccess = '';
	}

	async function saveAccountSettings() {
		if (!settingsAccount) return;
		settingsSaving = true;
		const effectiveRetention = keepForever ? 0 : settingsRetention;
		try {
			const res = await fetch('/api/inbox/accounts', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: settingsAccount.id,
					label: settingsLabel,
					retentionDays: effectiveRetention,
				}),
			});
			if (res.ok) {
				const data = await res.json();
				await loadAccounts();
				settingsAccount = null;
				// G3 visibility: surface the immediate-prune count when retention
				// changed. API returns null when retention wasn't touched.
				if (typeof data.pruned === 'number') {
					if (data.pruned > 0) {
						showFlash(`Settings saved — pruned ${data.pruned} old message${data.pruned === 1 ? '' : 's'}.`, 'success', 5000);
					} else {
						showFlash('Settings saved.', 'success', 3000);
					}
				}
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

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	// Pretty IMAP flag chips: drop \Seen (the unread dot already conveys it),
	// strip leading backslash, capitalize. Empty list = nothing rendered.
	function flagChips(flags: string[]): string[] {
		return flags
			.filter((f) => f !== '\\Seen')
			.map((f) => f.replace(/^\\/, ''));
	}

	// Mirror the active filter state to the URL so closing/reopening the tab
	// (or sharing the link) restores the view. replaceState — not pushState —
	// because filter changes shouldn't accumulate history entries; the URL is
	// purely a state survival mechanism, not a navigation surface.
	function syncUrl() {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams();
		if (selectedAccount) params.set('account', selectedAccount);
		if (statusFilter) params.set('status', statusFilter);
		if (search) params.set('q', search);
		const qs = params.toString();
		const next = qs ? `/inbox?${qs}` : '/inbox';
		// Avoid no-op replaceStates that show up as redundant history churn.
		if (window.location.pathname + window.location.search !== next) {
			window.history.replaceState({}, '', next);
		}
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
		const urlParams = new URLSearchParams(window.location.search);

		// Seed filter state from URL FIRST. This must run before the OAuth
		// flash branch below — that branch calls replaceState('/inbox'),
		// which would strip any inbox params it doesn't know about. After
		// state is seeded, the $effect on selectedAccount/statusFilter/search
		// re-writes the URL from state, so the params survive the strip.
		const urlAccount = urlParams.get('account');
		const urlStatus = urlParams.get('status');
		const urlQ = urlParams.get('q');
		if (urlAccount) selectedAccount = urlAccount;
		if (urlStatus) statusFilter = urlStatus;
		if (urlQ) search = urlQ;

		// Handle URL params (from OAuth callbacks). Error wins over success
		// when multiple flags arrive on the same redirect, and only one
		// timer ever runs (see showFlash).
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

<svelte:window onkeydown={onKeydown} />

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
					aria-label={showSidebar ? 'Close sidebar' : 'Open sidebar'}
					aria-expanded={showSidebar}
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
		{#if showSidebar}
			<button
				type="button"
				onclick={() => { showSidebar = false; }}
				aria-label="Close sidebar"
				class="fixed inset-0 bg-black/30 z-10 sm:hidden cursor-default"
			></button>
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
				<button
					type="button"
					onclick={() => { selectedAccount = null; loadMessages(); showSidebar = false; }}
					aria-pressed={selectedAccount === null}
					class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left {selectedAccount === null ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="text-xs">All accounts</span>
					<span class="ml-auto text-[10px] text-hub-dim">{stats.messages}</span>
				</button>
				{#each accounts as acc (acc.id)}
					{@const selectAcc = () => { selectedAccount = acc.id; loadMessages(); showSidebar = false; }}
					<div
						role="button"
						tabindex="0"
						aria-pressed={selectedAccount === acc.id}
						aria-label="Select {acc.label}"
						onclick={selectAcc}
						onkeydown={(e) => onRowKey(e, selectAcc)}
						class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors group focus:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50 {selectedAccount === acc.id ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
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
					<!-- Per-account staleness. Always rendered when lastSync is known;
					     "never synced" for fresh accounts that haven't completed a cycle yet. -->
					<p class="text-[10px] text-hub-dim px-6 -mt-0.5 mb-0.5">
						{acc.lastSync ? `synced ${timeAgo(acc.lastSync)} ago` : 'never synced'}
					</p>
					{#if acc.status === 'error' && acc.lastError}
						<button
							type="button"
							onclick={(e) => {
								e.stopPropagation();
								expandedErrorId = expandedErrorId === acc.id ? null : acc.id;
							}}
							class="flex items-start gap-1 w-full text-left px-6 -mt-0.5 mb-1 text-[10px] text-hub-danger/80 hover:text-hub-danger cursor-pointer"
							aria-expanded={expandedErrorId === acc.id}
							aria-label={expandedErrorId === acc.id ? 'Collapse error' : 'Expand error'}
						>
							<svg
								class="w-2.5 h-2.5 mt-0.5 flex-shrink-0 transition-transform {expandedErrorId === acc.id ? 'rotate-90' : ''}"
								viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
							>
								<polyline points="9 18 15 12 9 6"/>
							</svg>
							<span class="{expandedErrorId === acc.id ? 'break-words' : 'truncate'} flex-1">
								{acc.lastError}
							</span>
						</button>
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
					<button
						type="button"
						onclick={() => { statusFilter = filter.value; loadMessages(); }}
						aria-pressed={statusFilter === filter.value}
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-left {statusFilter === filter.value ? 'bg-hub-surface text-hub-text' : 'text-hub-muted hover:bg-hub-surface/50'}"
					>
						{#if filter.value}
							<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {processStatusColors[filter.value] || 'bg-hub-dim/50'}"></span>
						{/if}
						<span class="text-xs">{filter.label}</span>
					</button>
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
										{existingGmailCount === 0 ? 'Sign in with Google' : 'Add another Gmail account'}
									</a>
									{#if existingGmailCount > 0}
										<p class="text-[10px] text-hub-dim leading-relaxed">
											Google will let you choose a different account on the consent screen. To recover an existing account whose tokens expired, use <em>Reauthorize</em> from its settings instead.
										</p>
									{/if}
								{/if}
							</div>
						{:else if addProvider === 'outlook'}
							<div class="col-span-2 space-y-3">
								<p class="text-xs text-hub-muted">Outlook uses secure OAuth2 authentication.</p>
								<a href="/api/inbox/outlook" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500/15 text-sky-400 text-sm font-medium hover:bg-sky-500/25 transition-colors">
									<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z"/></svg>
									{existingOutlookCount === 0 ? 'Sign in with Microsoft' : 'Add another Microsoft account'}
								</a>
								{#if existingOutlookCount > 0}
									<p class="text-[10px] text-hub-dim leading-relaxed">
										Microsoft will let you choose a different account on the consent screen. Re-grant for an existing account is currently routed through Remove + re-add (in-place reauthorize lands with plan Open #2).
									</p>
								{/if}
							</div>
						{:else}
							{#if existingProviderCount > 0}
								<div class="col-span-2">
									<p class="text-[11px] text-hub-dim leading-relaxed">
										You already have {existingProviderCount} {addProvider === 'icloud' ? 'iCloud' : 'IMAP'} account{existingProviderCount === 1 ? '' : 's'} connected. Adding another? Use a different email — duplicates are blocked.
									</p>
								</div>
							{/if}
							<div>
								<label class="text-[10px] text-hub-dim uppercase tracking-wider">Label (optional)</label>
								<input type="text" bind:value={addLabel} placeholder="Work, Personal..." class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
							</div>
							<div>
								<label class="text-[10px] text-hub-dim uppercase tracking-wider">Email</label>
								<input type="email" bind:value={addEmail} bind:this={addEmailInput} placeholder="you@example.com" class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text placeholder:text-hub-dim focus:outline-none" />
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
						<button
							type="button"
							onclick={() => { selectedMessage = selectedMessage?.id === msg.id ? null : msg; }}
							aria-expanded={selectedMessage?.id === msg.id}
							class="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-hub-surface/30 transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50 {!msg.flags.includes('\\Seen') ? 'bg-hub-surface/10' : ''}"
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
						</button>

						{#if selectedMessage?.id === msg.id}
							{@const chips = flagChips(msg.flags)}
							{@const realAttachments = (msg.attachmentsMeta || []).filter((a) => !a.isInline)}
							{@const body = bodyCache.get(msg.id)}
							<div class="px-4 py-4 bg-hub-surface/20 border-b border-hub-border">
								<!-- Header: subject + metadata + flag chips -->
								<div class="flex items-start justify-between mb-2 gap-2">
									<div class="min-w-0 flex-1">
										<p class="text-sm font-medium text-hub-text">{msg.subject || '(no subject)'}</p>
										<p class="text-xs text-hub-muted mt-0.5">
											From: {msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}
										</p>
										<p class="text-xs text-hub-dim">To: {msg.toAddress}</p>
										{#if chips.length > 0}
											<div class="flex flex-wrap gap-1 mt-1.5">
												{#each chips as chip (chip)}
													<span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-hub-surface text-hub-muted">{chip}</span>
												{/each}
											</div>
										{/if}
									</div>
									<span class="text-[10px] text-hub-dim flex-shrink-0">
										{new Date(msg.dateSent ?? msg.dateReceived).toLocaleString()}
									</span>
								</div>

								<!-- Real (non-inline) attachments: filename + size. Inline images
								     are filtered out — they're cid: references embedded in HTML,
								     not user-facing attachments. Download wiring lands with plan
								     Open #4. -->
								{#if realAttachments.length > 0}
									<div class="mt-3 border-t border-hub-border/40 pt-2">
										<p class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Attachments ({realAttachments.length})</p>
										<ul class="space-y-1">
											{#each realAttachments as att (att.part || att.filename)}
												{#if att.part}
													<li>
														<a
															href={`/api/inbox/messages/${msg.id}/attachments/${att.part}`}
															download={att.filename}
															class="flex items-center gap-2 text-xs text-hub-muted hover:text-hub-text hover:bg-hub-surface/40 -mx-1 px-1 py-0.5 rounded transition-colors"
															title="Download {att.filename}"
														>
															<svg class="w-3 h-3 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
															<span class="truncate flex-1">{att.filename}</span>
															<span class="text-[10px] text-hub-dim flex-shrink-0">{formatBytes(att.size)}</span>
															<svg class="w-3 h-3 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
														</a>
													</li>
												{:else}
													<li class="flex items-center gap-2 text-xs text-hub-muted opacity-60" title="No part id captured at sync time — can't fetch">
														<svg class="w-3 h-3 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
														<span class="truncate flex-1" title={att.filename}>{att.filename}</span>
														<span class="text-[10px] text-hub-dim flex-shrink-0">{formatBytes(att.size)}</span>
													</li>
												{/if}
											{/each}
										</ul>
									</div>
								{/if}

								<!-- Body content: lazy fetch via /api/inbox/messages/[id]/body.
								     Defaults to text view; "View HTML" toggle shows the html in
								     a sandboxed iframe (no scripts, no forms, no popups). -->
								<div class="mt-3 border-t border-hub-border/40 pt-2">
									{#if bodyLoading}
										<p class="text-xs text-hub-dim italic">Loading body…</p>
									{:else if bodyError}
										<div class="space-y-2">
											<p class="text-xs text-hub-danger/80">{bodyError}</p>
											<button
												type="button"
												onclick={() => loadMessageBody(msg.id)}
												class="text-[11px] text-hub-cta hover:underline cursor-pointer"
											>
												Retry
											</button>
										</div>
									{:else if body}
										{#if body.html}
											<div class="flex items-center justify-end mb-2">
												<button
													type="button"
													onclick={() => { viewHtml = !viewHtml; }}
													class="text-[10px] text-hub-cta hover:underline cursor-pointer"
												>
													{viewHtml ? 'View as text' : 'View as HTML'}
												</button>
											</div>
										{/if}
										{#if viewHtml && body.html}
											<!-- Sandboxed iframe — no scripts, no forms, no top
											     navigation, no popups. Inline cid: images won't
											     resolve until plan Open #4 ships the attachment
											     endpoint and we rewrite cid: URIs. -->
											<iframe
												sandbox=""
												srcdoc={body.html}
												title="Email HTML body"
												class="w-full h-96 rounded border border-hub-border/40 bg-white"
											></iframe>
										{:else}
											<div class="text-xs text-hub-muted whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
												{body.text || '(empty body)'}
											</div>
										{/if}
									{:else}
										<!-- Pre-fetch fallback. Should only flash for a tick before
										     the $effect kicks loadMessageBody — keeps the panel
										     non-empty during the initial open. -->
										<div class="text-xs text-hub-muted whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
											{msg.bodyPreview || '(loading…)'}
										</div>
									{/if}
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
		<div class="fixed inset-0 z-30 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Account settings">
			<!-- Backdrop is a real button so Enter/Space closes the modal; Escape
			     also closes via the window keydown handler (see onKeydown). -->
			<button
				type="button"
				onclick={() => { settingsAccount = null; }}
				aria-label="Close settings"
				class="absolute inset-0 bg-black/40 cursor-default"
			></button>
			<!-- Content sits above the backdrop via relative z-index; no
			     stopPropagation needed since clicks here never reach the
			     backdrop (siblings, not parent-child). -->
			<div class="relative bg-hub-card border border-hub-border rounded-xl w-full max-w-sm p-5 shadow-xl">
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
						bind:this={settingsLabelInput}
						class="w-full mt-1 px-2 py-1.5 rounded bg-hub-surface border border-hub-border text-sm text-hub-text focus:outline-none focus:border-hub-cta/50"
					/>
				</div>

				<!-- Retention -->
				<div class="mb-5">
					<div class="flex items-center justify-between">
						<label class="text-[10px] text-hub-dim uppercase tracking-wider">Retention</label>
						<label class="flex items-center gap-1.5 text-[11px] text-hub-muted cursor-pointer">
							<input
								type="checkbox"
								bind:checked={keepForever}
								class="accent-hub-cta cursor-pointer"
							/>
							Never delete
						</label>
					</div>
					<div class="flex items-center gap-3 mt-1 {keepForever ? 'opacity-50' : ''}">
						<input
							type="range"
							min="1"
							max="365"
							bind:value={settingsRetention}
							disabled={keepForever}
							class="flex-1 accent-hub-cta"
						/>
						<div class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="365"
								bind:value={settingsRetention}
								disabled={keepForever}
								class="w-14 px-1.5 py-1 rounded bg-hub-surface border border-hub-border text-xs text-hub-text text-center focus:outline-none focus:border-hub-cta/50 disabled:cursor-not-allowed"
							/>
							<span class="text-[10px] text-hub-dim">days</span>
						</div>
					</div>
					<p class="text-[10px] text-hub-dim mt-1 leading-relaxed">
						{#if keepForever}
							All synced messages will be kept locally. Local cache only — never touches the remote mailbox.
						{:else}
							Locally cached messages older than {settingsRetention} day{settingsRetention === 1 ? '' : 's'} are deleted from this app. Flagged messages and messages that have been processed by agents are never pruned. The remote mailbox is never touched.
						{/if}
					</p>
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
