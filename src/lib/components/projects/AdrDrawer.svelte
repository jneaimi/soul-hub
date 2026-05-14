<script lang="ts">
	/** Side-viewer drawer for a single ADR / vault note.
	 *
	 *  Slides in from the right. Fetches `/api/vault/notes/<path>` to get the
	 *  pre-rendered HTML and frontmatter. For a proposed ADR (status field on
	 *  the note's frontmatter), embeds the same `DecisionActions` strip the
	 *  detail page and the queue use, so the operator can decide without
	 *  closing the drawer.
	 *
	 *  Closes on backdrop click + ESC. The parent owns open/close state.
	 */

	import { onMount, untrack } from 'svelte';
	import RenderedMarkdown from '../RenderedMarkdown.svelte';
	import DecisionActions from './DecisionActions.svelte';

	interface NotePayload {
		path: string;
		title: string;
		meta: Record<string, unknown>;
		rendered: string;
		contentIsRtl?: boolean;
		links?: string[];
		backlinks?: string[];
	}

	type DrawerAction = 'accept' | 'reject' | 'park' | 'ship';

	interface Props {
		path: string | null;
		onClose: () => void;
		onTransition?: (info: { path: string; action: DrawerAction; newStatus: string }) => void;
	}

	let { path, onClose, onTransition }: Props = $props();

	let note = $state<NotePayload | null>(null);
	let loading = $state(false);
	let error = $state('');

	// Phase 3a affordances state
	let shipping = $state(false);
	let savingTarget = $state(false);
	let targetDateInput = $state('');
	let editingTarget = $state(false);
	let mutationError = $state('');

	const status = $derived(note ? String(note.meta.status ?? '').toLowerCase() : '');
	const isProposed = $derived(status === 'proposed');
	const isAccepted = $derived(status === 'accepted');

	const created = $derived(extractDate(note?.meta.created));
	const targetDate = $derived(extractDate(note?.meta.target_date));
	const acceptedOn = $derived(extractDate(note?.meta.accepted_on));
	const shippedOn = $derived(extractDate(note?.meta.shipped_on));
	const project = $derived(typeof note?.meta.project === 'string' ? note.meta.project : '');
	const tags = $derived(extractStringArray(note?.meta.tags));
	const falsifierDate = $derived(
		extractDate(note?.meta.falsifier_date) ?? extractDate(note?.meta.falsifierDate),
	);

	function extractDate(raw: unknown): string | null {
		if (typeof raw === 'string') return raw.trim() || null;
		if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
			return raw.toISOString().slice(0, 10);
		}
		// Vault API serializes Date through JSON, so it arrives as ISO string —
		// but the JSON parse can also surface it as the original value if it
		// was already a string. Handled above.
		return null;
	}

	function extractStringArray(raw: unknown): string[] {
		if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
		if (typeof raw === 'string') return [raw];
		return [];
	}

	async function load(p: string) {
		loading = true;
		error = '';
		note = null;
		try {
			const res = await fetch(`/api/vault/notes/${p}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			note = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load note';
		} finally {
			loading = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && path) onClose();
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	$effect(() => {
		const p = path;
		untrack(() => {
			if (p) load(p);
			else { note = null; error = ''; }
		});
	});

	function handleTransition(info: { path: string; action: DrawerAction; newStatus: string }) {
		onTransition?.(info);
		// Close after a successful transition — the row in the parent list
		// will update or vanish, so keeping the drawer open shows stale data.
		onClose();
	}

	async function shipDecision() {
		if (!note || shipping) return;
		shipping = true;
		mutationError = '';
		try {
			const res = await fetch('/api/vault/decisions/transition', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: note.path, action: 'ship' }),
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				mutationError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			handleTransition({ path: note.path, action: 'ship', newStatus: data.newStatus });
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Network error';
		} finally {
			shipping = false;
		}
	}

	async function saveTargetDate() {
		if (!note || savingTarget) return;
		const value = targetDateInput.trim();
		if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			mutationError = 'Date must be YYYY-MM-DD';
			return;
		}
		savingTarget = true;
		mutationError = '';
		try {
			// Patch only the target_date field. Empty string clears it.
			const meta: Record<string, unknown> = { ...note.meta, target_date: value || null };
			if (!value) delete meta.target_date;
			const res = await fetch(`/api/vault/notes/${note.path}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta }),
			});
			const data = await res.json();
			if (!res.ok || data.success === false) {
				mutationError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			editingTarget = false;
			// Refresh the note so the chip reflects the new value.
			await load(note.path);
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Network error';
		} finally {
			savingTarget = false;
		}
	}

	function startEditingTarget() {
		targetDateInput = targetDate ?? '';
		editingTarget = true;
		mutationError = '';
	}
</script>

{#if path}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 bg-black/50 z-40 transition-opacity"
		onclick={onClose}
		role="presentation"
	></div>

	<!-- Drawer -->
	<aside
		class="fixed top-0 right-0 bottom-0 w-full sm:w-[640px] lg:w-[760px] bg-hub-bg border-l border-hub-border z-50 flex flex-col shadow-2xl"
		role="dialog"
		aria-label="ADR viewer"
	>
		<header class="flex-shrink-0 px-5 py-3 border-b border-hub-border flex items-center justify-between">
			<div class="min-w-0 flex-1">
				{#if note}
					<h2 class="text-sm font-semibold text-hub-text truncate">{note.title}</h2>
					<p class="text-[11px] text-hub-dim font-mono truncate">{note.path}</p>
				{:else if loading}
					<p class="text-sm text-hub-muted">Loading…</p>
				{:else}
					<p class="text-sm text-hub-muted">{path}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2 flex-shrink-0 ml-3">
				{#if note}
					<a
						href="/vault?path={encodeURIComponent(note.path)}"
						class="text-[11px] text-hub-dim hover:text-hub-text transition-colors"
						title="Open in vault"
					>
						Open in vault →
					</a>
				{/if}
				<button
					onclick={onClose}
					class="p-1.5 rounded-md hover:bg-hub-card text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
					aria-label="Close"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			</div>
		</header>

		<div class="flex-1 overflow-y-auto px-5 py-5">
			{#if loading && !note}
				<div class="flex items-center justify-center py-20">
					<p class="text-hub-muted text-sm">Loading…</p>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{:else if note}
				<!-- Frontmatter chips -->
				<div class="flex flex-wrap items-center gap-2 mb-4 text-[11px]">
					{#if status}
						<span
							class="px-2 py-0.5 rounded font-medium"
							class:bg-hub-warning={status === 'proposed'}
							class:text-hub-bg={status === 'proposed'}
							class:bg-hub-info={status === 'accepted'}
							class:text-white={status === 'accepted' || status === 'shipped' || status === 'rejected'}
							class:bg-hub-cta={status === 'shipped'}
							class:bg-hub-danger={status === 'rejected'}
							class:bg-hub-dim={status === 'parked'}
							class:bg-hub-muted={status === 'superseded'}
							class:line-through={status === 'superseded'}
						>
							{status}
						</span>
					{/if}
					{#if project}
						<a href="/projects/{project}" class="px-2 py-0.5 rounded bg-hub-card text-hub-info hover:text-hub-text transition-colors">
							{project}
						</a>
					{/if}
					{#if created}
						<span class="text-hub-dim">created {created}</span>
					{/if}
					{#if acceptedOn}
						<span class="text-hub-info">accepted {acceptedOn}</span>
					{/if}
					{#if shippedOn}
						<span class="text-hub-cta">shipped {shippedOn}</span>
					{/if}
					{#if targetDate && isProposed}
						<span class="text-hub-warning">target {targetDate}</span>
					{/if}
					{#if falsifierDate}
						<span class="text-hub-warning">⏱ {falsifierDate}</span>
					{/if}
					{#each tags.slice(0, 6) as tag}
						<span class="px-1.5 py-0.5 rounded bg-hub-card/60 text-hub-dim">{tag}</span>
					{/each}
				</div>

				<!-- Action strip for proposed ADRs -->
				{#if isProposed}
					<div class="mb-5 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="flex items-center justify-between gap-3 mb-1">
							<p class="text-xs text-hub-warning">Awaiting decision</p>
							<DecisionActions path={note.path} size="sm" onTransition={handleTransition} />
						</div>

						<!-- Target date editor — drives the planned-Gantt view (Phase 3a) -->
						<div class="mt-3 pt-3 border-t border-hub-warning/20 flex items-center gap-2 text-[11px]">
							<span class="text-hub-dim">Target ship date:</span>
							{#if editingTarget}
								<input
									bind:value={targetDateInput}
									type="text"
									placeholder="YYYY-MM-DD"
									pattern="\d{'{4}'}-\d{'{2}'}-\d{'{2}'}"
									class="bg-transparent border border-hub-border rounded px-2 py-0.5 text-[11px] text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors w-32"
								/>
								<button
									onclick={saveTargetDate}
									disabled={savingTarget}
									class="px-2 py-0.5 rounded font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
								>
									{savingTarget ? '…' : 'Save'}
								</button>
								<button
									onclick={() => { editingTarget = false; mutationError = ''; }}
									class="px-2 py-0.5 rounded text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
								>
									Cancel
								</button>
							{:else}
								<span class={targetDate ? 'text-hub-text font-medium' : 'text-hub-dim italic'}>
									{targetDate ?? 'not set'}
								</span>
								<button
									onclick={startEditingTarget}
									class="text-hub-info hover:text-hub-text transition-colors cursor-pointer"
								>
									{targetDate ? 'Update' : 'Set'}
								</button>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Ship button for accepted ADRs (Phase 3a) -->
				{#if isAccepted}
					<div class="mb-5 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5 flex items-center justify-between gap-3">
						<div>
							<p class="text-xs text-hub-info">Decision accepted{acceptedOn ? ` on ${acceptedOn}` : ''}</p>
							<p class="text-[11px] text-hub-dim mt-0.5">Mark as shipped when all planned phases are live.</p>
						</div>
						<button
							onclick={shipDecision}
							disabled={shipping}
							class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
						>
							{shipping ? '…' : 'Mark shipped'}
						</button>
					</div>
				{/if}

				{#if mutationError}
					<div class="mb-4 px-3 py-2 rounded bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
						{mutationError}
					</div>
				{/if}

				<RenderedMarkdown html={note.rendered ?? ''} rtl={!!note.contentIsRtl} />

				<!-- Backlinks -->
				{#if note.backlinks && note.backlinks.length > 0}
					<div class="mt-6 pt-4 border-t border-hub-border">
						<p class="text-[11px] uppercase tracking-wider text-hub-dim mb-2">
							Linked from ({note.backlinks.length})
						</p>
						<ul class="space-y-1 text-xs">
							{#each note.backlinks.slice(0, 12) as bl}
								<li>
									<a
										href="/vault?path={encodeURIComponent(bl)}"
										class="text-hub-info hover:text-hub-text font-mono transition-colors"
									>
										{bl}
									</a>
								</li>
							{/each}
							{#if note.backlinks.length > 12}
								<li class="text-hub-dim">+{note.backlinks.length - 12} more</li>
							{/if}
						</ul>
					</div>
				{/if}
			{/if}
		</div>
	</aside>
{/if}
