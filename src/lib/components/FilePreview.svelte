<script lang="ts">
	import { marked } from 'marked';

	interface Props {
		filePath: string;
		fileName: string;
		onClose: () => void;
	}

	let { filePath, fileName, onClose }: Props = $props();

	let content = $state('');
	let highlightedHtml = $state('');
	let loading = $state(true);
	let error = $state('');
	let fileSize = $state(0);

	// Extract directory and file from full path
	const dir = $derived(filePath.substring(0, filePath.lastIndexOf('/')));
	const file = $derived(filePath.substring(filePath.lastIndexOf('/') + 1));

	const langMap: Record<string, string> = {
		ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
		svelte: 'svelte', vue: 'vue', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
		css: 'css', scss: 'scss', html: 'html', json: 'json', yaml: 'yaml', yml: 'yaml',
		md: 'markdown', mdx: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
		toml: 'toml', sql: 'sql', xml: 'xml', c: 'c', cpp: 'cpp', h: 'c',
		java: 'java', kt: 'kotlin', swift: 'swift', dart: 'dart',
		dockerfile: 'dockerfile', makefile: 'makefile', graphql: 'graphql',
	};

	function getLanguage(name: string): string {
		const lower = name.toLowerCase();
		if (lower === 'dockerfile') return 'dockerfile';
		if (lower === 'makefile') return 'makefile';
		const ext = name.split('.').pop()?.toLowerCase() || '';
		return langMap[ext] || 'text';
	}

	async function highlightCode(code: string, lang: string) {
		try {
			const { codeToHtml } = await import('shiki');
			highlightedHtml = await codeToHtml(code, {
				lang: lang === 'text' ? 'plaintext' : lang,
				theme: 'github-dark-default',
			});
		} catch {
			// Fallback: if shiki doesn't know the language, use plaintext
			try {
				const { codeToHtml } = await import('shiki');
				highlightedHtml = await codeToHtml(code, {
					lang: 'plaintext',
					theme: 'github-dark-default',
				});
			} catch {
				highlightedHtml = '';
			}
		}
	}

	$effect(() => {
		loading = true;
		error = '';
		content = '';
		highlightedHtml = '';

		// Images are loaded directly via <img> tag
		if (isImage) {
			loading = false;
			return;
		}

		fetch(`/api/files?path=${encodeURIComponent(dir)}&action=read&file=${encodeURIComponent(file)}`)
			.then(async (res) => {
				if (!res.ok) {
					const data = await res.json();
					throw new Error(data.error || `HTTP ${res.status}`);
				}
				return res.json();
			})
			.then(async (data) => {
				content = data.content;
				fileSize = data.size;
				loading = false;

				// Highlight code after content loads (non-blocking)
				if (!isMarkdown) {
					const lang = getLanguage(fileName);
					await highlightCode(data.content, lang);
				}
			})
			.catch((e) => {
				error = e.message;
				loading = false;
			});
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	const lineCount = $derived(content ? content.split('\n').length : 0);
	const isMarkdown = $derived(/\.(md|mdx)$/i.test(fileName));
	const isImage = $derived(/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(fileName));
	const renderedMarkdown = $derived(isMarkdown && content ? marked.parse(content, { async: false }) as string : '');
	const rawUrl = $derived(`/api/files?path=${encodeURIComponent(dir)}&action=raw&file=${encodeURIComponent(file)}`);
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
	onclick={handleOverlayClick}
>
	<div class="absolute right-0 top-0 bottom-0 w-full max-w-2xl bg-hub-bg border-l border-hub-border flex flex-col shadow-2xl">
		<!-- Header -->
		<div class="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-hub-border bg-hub-surface/50">
			<div class="flex items-center gap-2 min-w-0">
				<svg class="w-4 h-4 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
				</svg>
				<span class="text-sm font-medium text-hub-text truncate">{fileName}</span>
				<span class="text-[10px] text-hub-dim flex-shrink-0 px-1.5 py-0.5 bg-hub-card rounded">{getLanguage(fileName)}</span>
			</div>
			<div class="flex items-center gap-3">
				{#if fileSize}
					<span class="text-[10px] text-hub-dim">{formatBytes(fileSize)} · {lineCount} lines</span>
				{/if}
				<button
					onclick={onClose}
					class="p-1 rounded hover:bg-hub-card transition-colors cursor-pointer text-hub-dim hover:text-hub-text"
					title="Close preview"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			</div>
		</div>

		<!-- File path -->
		<div class="flex-shrink-0 px-4 py-1.5 border-b border-hub-border/50 bg-hub-surface/30">
			<span class="text-[10px] text-hub-dim font-mono truncate block">{filePath}</span>
		</div>

		<!-- Content -->
		<div class="flex-1 overflow-auto">
			{#if loading}
				<div class="flex items-center justify-center h-full">
					<span class="text-sm text-hub-dim">Loading...</span>
				</div>
			{:else if error}
				<div class="flex items-center justify-center h-full">
					<div class="text-center">
						<svg class="w-8 h-8 text-hub-danger mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
						</svg>
						<p class="text-sm text-hub-danger">{error}</p>
					</div>
				</div>
			{:else if isImage}
				<div class="flex items-center justify-center h-full p-6 bg-[#0a0a0f]">
					<img
						src={rawUrl}
						alt={fileName}
						class="max-w-full max-h-full object-contain rounded-lg"
					/>
				</div>
			{:else if isMarkdown}
				<div class="prose-hub p-5 text-sm leading-relaxed">
					{@html renderedMarkdown}
				</div>
			{:else if highlightedHtml}
				<div class="shiki-preview">
					{@html highlightedHtml}
				</div>
			{:else}
				<!-- Plain text fallback while shiki loads -->
				<div class="relative">
					<pre class="text-xs leading-relaxed font-mono p-4 text-hub-text whitespace-pre overflow-x-auto">{#each content.split('\n') as line, i}<span class="inline-block w-10 text-right pr-4 text-hub-dim/40 select-none">{i + 1}</span>{line}
{/each}</pre>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Shiki output styling */
	.shiki-preview :global(pre) {
		margin: 0;
		padding: 1rem;
		font-size: 0.8rem;
		line-height: 1.6;
		overflow-x: auto;
		background: #0a0a0f !important;
	}
	.shiki-preview :global(code) {
		font-family: 'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
		counter-reset: line;
	}
	.shiki-preview :global(.line) {
		counter-increment: line;
		display: inline-block;
		width: 100%;
	}
	.shiki-preview :global(.line::before) {
		content: counter(line);
		display: inline-block;
		width: 3rem;
		text-align: right;
		padding-right: 1rem;
		margin-right: 0.75rem;
		color: #334155;
		font-size: 0.75rem;
		user-select: none;
		border-right: 1px solid #1e293b;
	}
</style>
