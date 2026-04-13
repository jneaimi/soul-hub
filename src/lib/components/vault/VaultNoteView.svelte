<script lang="ts">
	import { marked } from 'marked';
	import type { VaultNote } from '$lib/vault/types';
	import { TYPE_COLORS } from '$lib/vault/types';

	interface Props {
		note: VaultNote;
		vaultDir?: string;
		onNavigate: (path: string) => void;
		onEdit: () => void;
		onArchive: () => void;
	}

	let { note, vaultDir = '', onNavigate, onEdit, onArchive }: Props = $props();

	const downloadUrl = $derived(
		vaultDir
			? `/api/files?path=${encodeURIComponent(vaultDir + '/' + note.path.substring(0, note.path.lastIndexOf('/')))}&action=raw&file=${encodeURIComponent(note.path.split('/').pop() || '')}`
			: ''
	);

	let confirmingArchive = $state(false);
	let contentEl = $state<HTMLDivElement | null>(null);

	// Note directory for resolving relative paths
	const noteDir = $derived(note.path.substring(0, note.path.lastIndexOf('/')) || '');

	/**
	 * Resolve a relative image/media path to a vault file API URL.
	 * Handles: relative paths, vault-root paths, and already-absolute URLs.
	 */
	function resolveMediaSrc(src: string): string {
		if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/api/')) return src;
		if (!vaultDir) return src;
		// Resolve relative to note's directory
		const fullDir = noteDir ? `${vaultDir}/${noteDir}` : vaultDir;
		return `/api/files?path=${encodeURIComponent(fullDir)}&action=raw&file=${encodeURIComponent(src)}`;
	}

	const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;
	const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i;
	const AUDIO_EXTS = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;

	/**
	 * Custom marked renderer for enhanced media support.
	 */
	function createRenderer() {
		const renderer = new marked.Renderer();

		// Images — resolve vault-relative paths
		renderer.image = function ({ href, title, text }: { href: string; title: string | null; text: string }) {
			const src = resolveMediaSrc(href);
			const titleAttr = title ? ` title="${title}"` : '';

			if (VIDEO_EXTS.test(href)) {
				return `<div class="vault-media"><video src="${src}" controls class="vault-video"${titleAttr}></video>${text ? `<p class="vault-caption">${text}</p>` : ''}</div>`;
			}
			if (AUDIO_EXTS.test(href)) {
				return `<div class="vault-media"><audio src="${src}" controls class="vault-audio"></audio>${text ? `<p class="vault-caption">${text}</p>` : ''}</div>`;
			}
			return `<div class="vault-media"><img src="${src}" alt="${text || ''}" loading="lazy" class="vault-image"${titleAttr} />${text ? `<p class="vault-caption">${text}</p>` : ''}</div>`;
		};

		// Code blocks — add language label + copy button placeholder
		renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
			const langLabel = lang || '';
			const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			return `<div class="vault-code-block" data-lang="${langLabel}"><div class="vault-code-header"><span class="vault-code-lang">${langLabel}</span><button class="vault-code-copy" onclick="navigator.clipboard.writeText(this.closest('.vault-code-block').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy'},1500)})">Copy</button></div><pre><code class="language-${langLabel}">${escaped}</code></pre></div>`;
		};

		// Links — detect media file links and render inline
		const originalLink = marked.Renderer.prototype.link;
		renderer.link = function ({ href, title, text }: { href: string; title: string | null; text: string }) {
			if (IMAGE_EXTS.test(href)) {
				const src = resolveMediaSrc(href);
				return `<div class="vault-media"><img src="${src}" alt="${text || ''}" loading="lazy" class="vault-image" /></div>`;
			}
			if (VIDEO_EXTS.test(href)) {
				const src = resolveMediaSrc(href);
				return `<div class="vault-media"><video src="${src}" controls class="vault-video"></video></div>`;
			}
			if (AUDIO_EXTS.test(href)) {
				const src = resolveMediaSrc(href);
				return `<div class="vault-media"><audio src="${src}" controls class="vault-audio"></audio></div>`;
			}
			return originalLink.call(this, { href, title, text });
		};

		return renderer;
	}

	function renderContent(content: string): string {
		const renderer = createRenderer();
		const html = marked.parse(content, { renderer }) as string;
		return processWikilinks(html);
	}

	const renderedHtml = $derived(renderContent(note.content));

	const zone = $derived(note.path.split('/')[0] || '');
	const typeColor = $derived(TYPE_COLORS[note.meta.type ?? ''] || '#6b7280');

	function processWikilinks(html: string): string {
		return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, target, alias) => {
			const display = alias || target;
			return `<a class="vault-wikilink" data-target="${target}">${display}</a>`;
		});
	}

	// Syntax highlighting — applied after render, non-blocking
	async function highlightCodeBlocks() {
		if (!contentEl) return;
		const blocks = contentEl.querySelectorAll('.vault-code-block pre code');
		if (blocks.length === 0) return;

		try {
			const { codeToHtml } = await import('shiki');
			for (const block of blocks) {
				const code = block.textContent || '';
				const lang = (block as HTMLElement).className.replace('language-', '') || 'text';
				try {
					const highlighted = await codeToHtml(code, {
						lang: lang === 'text' || lang === '' ? 'plaintext' : lang,
						theme: 'github-dark-default',
					});
					const wrapper = block.closest('.vault-code-block');
					if (wrapper) {
						const pre = wrapper.querySelector('pre');
						if (pre) {
							// Replace pre content with highlighted version
							const temp = document.createElement('div');
							temp.innerHTML = highlighted;
							const newPre = temp.querySelector('pre');
							if (newPre) {
								newPre.style.margin = '0';
								newPre.style.borderRadius = '0 0 0.5rem 0.5rem';
								pre.replaceWith(newPre);
							}
						}
					}
				} catch {
					// If shiki doesn't know the language, try plaintext
					try {
						const highlighted = await codeToHtml(code, { lang: 'plaintext', theme: 'github-dark-default' });
						const wrapper = block.closest('.vault-code-block');
						const pre = wrapper?.querySelector('pre');
						if (pre) {
							const temp = document.createElement('div');
							temp.innerHTML = highlighted;
							const newPre = temp.querySelector('pre');
							if (newPre) {
								newPre.style.margin = '0';
								newPre.style.borderRadius = '0 0 0.5rem 0.5rem';
								pre.replaceWith(newPre);
							}
						}
					} catch { /* keep unhighlighted */ }
				}
			}
		} catch {
			// shiki not available — keep plain code blocks
		}
	}

	// Re-highlight when note changes
	$effect(() => {
		// Track note.path to re-run when note changes
		void note.path;
		// Wait for DOM update
		requestAnimationFrame(() => highlightCodeBlocks());
	});

	function timeAgo(mtime: number): string {
		const seconds = Math.floor((Date.now() - mtime) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
		return new Date(mtime).toLocaleDateString();
	}

	function handleContentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const wikilink = target.closest('.vault-wikilink') as HTMLElement | null;
		if (wikilink) {
			e.preventDefault();
			const linkTarget = wikilink.dataset.target;
			if (linkTarget) onNavigate(linkTarget);
		}
	}

	function handleArchiveClick() {
		if (confirmingArchive) {
			onArchive();
			confirmingArchive = false;
		} else {
			confirmingArchive = true;
			setTimeout(() => { confirmingArchive = false; }, 3000);
		}
	}

	/**
	 * Detect if text is predominantly RTL (Arabic, Hebrew, etc.)
	 * Returns true if >30% of alphabetic characters are RTL script.
	 */
	function isRtl(text: string): boolean {
		const rtlChars = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/g);
		if (!rtlChars) return false;
		const latinChars = text.match(/[a-zA-Z]/g);
		const totalAlpha = (rtlChars?.length || 0) + (latinChars?.length || 0);
		return totalAlpha > 0 && (rtlChars.length / totalAlpha) > 0.3;
	}

	const contentIsRtl = $derived(isRtl(note.content));
	const titleIsRtl = $derived(isRtl(note.title));

	const resolvedLinks = $derived(note.links.filter(l => l.resolved));
	const unresolvedLinks = $derived(note.links.filter(l => !l.resolved));
</script>

<div class="flex flex-col gap-4">
	<!-- Header bar -->
	<div class="flex items-center gap-3 flex-wrap">
		<button
			onclick={() => onNavigate('')}
			class="text-hub-muted hover:text-hub-text text-sm transition-colors"
		>
			&larr; Back
		</button>

		{#if note.meta.type}
			<span
				class="px-2 py-0.5 rounded text-xs font-medium text-white"
				style="background-color: {typeColor}"
			>
				{note.meta.type}
			</span>
		{/if}

		<span class="text-hub-dim text-sm">
			{zone}{zone ? ' / ' : ''}{note.path}
		</span>

		<div class="ml-auto flex items-center gap-2">
			{#if downloadUrl}
				<a
					href={downloadUrl}
					download={note.path.split('/').pop() || 'note.md'}
					class="px-3 py-1 text-sm rounded bg-hub-card text-hub-muted hover:text-hub-text transition-colors"
					title="Download"
				>
					Download
				</a>
			{/if}
			<button
				onclick={onEdit}
				class="px-3 py-1 text-sm rounded bg-hub-info/20 text-hub-info hover:bg-hub-info/30 transition-colors"
			>
				Edit
			</button>
			<button
				onclick={handleArchiveClick}
				class="px-3 py-1 text-sm rounded transition-colors {confirmingArchive
					? 'bg-hub-danger/20 text-hub-danger'
					: 'bg-hub-card text-hub-muted hover:text-hub-text'}"
			>
				{confirmingArchive ? 'Confirm?' : 'Archive'}
			</button>
		</div>
	</div>

	<!-- Metadata -->
	<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
		<h1 class="text-xl font-semibold text-hub-text mb-3" dir={titleIsRtl ? 'rtl' : undefined}>{note.title}</h1>

		{#if note.meta.tags && note.meta.tags.length > 0}
			<div class="flex items-center gap-2 flex-wrap mb-2">
				<span class="text-hub-dim text-sm">Tags:</span>
				{#each note.meta.tags as tag}
					<span class="px-2 py-0.5 rounded bg-hub-card text-hub-muted text-xs">
						{tag}
					</span>
				{/each}
			</div>
		{/if}

		<div class="flex items-center gap-4 text-sm text-hub-dim flex-wrap">
			{#if note.meta.created}
				<span>Created: {note.meta.created}</span>
			{/if}
			<span>Modified: {timeAgo(note.mtime)}</span>
			{#if note.meta.project}
				<span>Project: <span class="text-hub-muted">{note.meta.project}</span></span>
			{/if}
			{#if note.meta.status}
				<span>Status: <span class="text-hub-muted">{note.meta.status}</span></span>
			{/if}
		</div>
	</div>

	<!-- Rendered content -->
	<div
		bind:this={contentEl}
		class="vault-prose bg-hub-surface rounded-lg p-6 border border-hub-border"
		dir={contentIsRtl ? 'rtl' : undefined}
		lang={contentIsRtl ? 'ar' : undefined}
		onclick={handleContentClick}
		role="presentation"
	>
		{@html renderedHtml}
	</div>

	<!-- Outgoing links -->
	{#if note.links.length > 0}
		<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
			<h3 class="text-sm font-medium text-hub-muted mb-2">
				Outgoing Links ({note.links.length})
			</h3>
			<ul class="space-y-1">
				{#each resolvedLinks as link}
					<li>
						<button
							onclick={() => onNavigate(link.resolved!)}
							class="text-sm text-hub-info hover:underline"
						>
							{link.alias || link.raw}
						</button>
					</li>
				{/each}
				{#each unresolvedLinks as link}
					<li class="text-sm text-hub-dim italic">
						{link.alias || link.raw} (unresolved)
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Backlinks -->
	{#if note.backlinks.length > 0}
		<div class="bg-hub-surface rounded-lg p-4 border border-hub-border">
			<h3 class="text-sm font-medium text-hub-muted mb-2">
				Backlinks ({note.backlinks.length})
			</h3>
			<ul class="space-y-1">
				{#each note.backlinks as bl}
					<li>
						<button
							onclick={() => onNavigate(bl)}
							class="text-sm text-hub-purple hover:underline"
						>
							{bl.split('/').pop()?.replace('.md', '') || bl}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	/* Base prose */
	:global(.vault-prose) {
		color: var(--color-hub-text, #F8FAFC);
		line-height: 1.7;
	}
	:global(.vault-prose h1) { font-size: 1.5rem; font-weight: 700; margin: 1.5rem 0 0.75rem; }
	:global(.vault-prose h2) { font-size: 1.25rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
	:global(.vault-prose h3) { font-size: 1.1rem; font-weight: 600; margin: 1rem 0 0.5rem; }
	:global(.vault-prose p) { margin: 0.5rem 0; }
	:global(.vault-prose ul, .vault-prose ol) { padding-inline-start: 1.5rem; margin: 0.5rem 0; }
	:global(.vault-prose li) { margin: 0.25rem 0; }

	/* Inline code */
	:global(.vault-prose code) {
		background: var(--color-hub-card, #1E293B);
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
	}

	/* Code blocks */
	:global(.vault-code-block) {
		margin: 0.75rem 0;
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-code-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.35rem 0.75rem;
		background: var(--color-hub-card, #1E293B);
		border-bottom: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-code-lang) {
		font-size: 0.7rem;
		color: var(--color-hub-dim, #64748B);
		font-family: 'JetBrains Mono', 'Fira Code', monospace;
		text-transform: lowercase;
	}
	:global(.vault-code-copy) {
		font-size: 0.65rem;
		color: var(--color-hub-dim, #64748B);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.15rem 0.5rem;
		border-radius: 0.25rem;
		transition: color 0.15s, background 0.15s;
	}
	:global(.vault-code-copy:hover) {
		color: var(--color-hub-text, #F8FAFC);
		background: rgba(255,255,255,0.05);
	}
	:global(.vault-code-block pre) {
		background: #0d1117 !important;
		padding: 1rem;
		margin: 0;
		overflow-x: auto;
		font-size: 0.8rem;
		line-height: 1.6;
	}
	:global(.vault-code-block pre code) {
		background: none !important;
		padding: 0;
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
	}

	/* Legacy pre (without code-block wrapper — e.g. from wikilinks) */
	:global(.vault-prose > pre) {
		background: var(--color-hub-card, #1E293B);
		padding: 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 0.75rem 0;
	}
	:global(.vault-prose > pre code) {
		background: none;
		padding: 0;
	}

	/* Media */
	:global(.vault-media) {
		margin: 1rem 0;
		text-align: center;
	}
	:global(.vault-image) {
		max-width: 100%;
		max-height: 500px;
		object-fit: contain;
		border-radius: 0.5rem;
		border: 1px solid var(--color-hub-border, #334155);
	}
	:global(.vault-video) {
		max-width: 100%;
		max-height: 500px;
		border-radius: 0.5rem;
	}
	:global(.vault-audio) {
		width: 100%;
		max-width: 400px;
	}
	:global(.vault-caption) {
		font-size: 0.8rem;
		color: var(--color-hub-dim, #64748B);
		margin-top: 0.35rem;
	}

	/* Blockquotes */
	:global(.vault-prose blockquote) {
		border-inline-start: 3px solid var(--color-hub-border, #334155);
		padding-inline-start: 1rem;
		color: var(--color-hub-muted, #94A3B8);
		margin: 0.75rem 0;
	}

	/* Links */
	:global(.vault-prose a:not(.vault-wikilink)) {
		color: #3B82F6;
		text-decoration: underline;
	}
	:global(.vault-wikilink) {
		color: #A78BFA;
		cursor: pointer;
		text-decoration: none;
		border-bottom: 1px dashed #A78BFA;
	}
	:global(.vault-wikilink:hover) {
		color: #c4b5fd;
		border-bottom-style: solid;
	}

	/* Horizontal rules */
	:global(.vault-prose hr) {
		border-color: var(--color-hub-border, #334155);
		margin: 1rem 0;
	}

	/* Tables */
	:global(.vault-prose table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.75rem 0;
		font-size: 0.875rem;
	}
	:global(.vault-prose th, .vault-prose td) {
		border: 1px solid var(--color-hub-border, #334155);
		padding: 0.5rem 0.75rem;
		text-align: start;
	}
	:global(.vault-prose th) {
		background: var(--color-hub-card, #1E293B);
		font-weight: 600;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--color-hub-muted, #94A3B8);
	}
	:global(.vault-prose tr:hover td) {
		background: rgba(255,255,255,0.02);
	}

	/* Shiki output */
	:global(.vault-code-block .shiki) {
		background: #0d1117 !important;
	}
	:global(.vault-code-block .shiki code) {
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
		font-size: 0.8rem;
	}
</style>
