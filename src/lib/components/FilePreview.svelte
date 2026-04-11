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

		// Media files are loaded directly via native elements
		if (isMedia || isPdf) {
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
	const isVideo = $derived(/\.(mp4|webm|mov|avi|mkv)$/i.test(fileName));
	const isAudio = $derived(/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(fileName));
	const isCsv = $derived(/\.csv$/i.test(fileName));
	const isPdf = $derived(/\.pdf$/i.test(fileName));
	const isMedia = $derived(isImage || isVideo || isAudio);
	const renderedMarkdown = $derived(isMarkdown && content ? marked.parse(content, { async: false }) as string : '');
	const rawUrl = $derived(`/api/files?path=${encodeURIComponent(dir)}&action=raw&file=${encodeURIComponent(file)}`);

	function parseCsv(raw: string): string[][] {
		const lines = raw.trim().split('\n');
		return lines.slice(0, 51).map(line => line.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
	}
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
				<span class="text-[10px] text-hub-dim flex-shrink-0 px-1.5 py-0.5 bg-hub-card rounded">{isVideo ? 'video' : isAudio ? 'audio' : isPdf ? 'pdf' : isCsv ? 'csv' : getLanguage(fileName)}</span>
			</div>
			<div class="flex items-center gap-2">
				{#if fileSize}
					<span class="text-[10px] text-hub-dim mr-1">{formatBytes(fileSize)}{#if lineCount && !isMedia && !isPdf} · {lineCount} lines{/if}</span>
				{/if}
				<a
					href={rawUrl}
					download={fileName}
					class="p-1 rounded hover:bg-hub-card transition-colors text-hub-dim hover:text-hub-text"
					title="Download"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
					</svg>
				</a>
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
			{:else if isVideo}
				<div class="flex items-center justify-center h-full p-6 bg-[#0a0a0f]">
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={rawUrl} controls class="max-w-full max-h-full rounded-lg"></video>
				</div>
			{:else if isAudio}
				<div class="flex items-center justify-center h-full p-6 bg-[#0a0a0f]">
					<div class="w-full max-w-md">
						<div class="text-center mb-4">
							<svg class="w-12 h-12 text-hub-dim mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
							</svg>
							<p class="text-sm text-hub-muted mt-2">{fileName}</p>
						</div>
						<audio src={rawUrl} controls class="w-full"></audio>
					</div>
				</div>
			{:else if isPdf}
				<div class="flex items-center justify-center h-full p-6 bg-[#0a0a0f]">
					<div class="text-center">
						<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
						</svg>
						<p class="text-sm text-hub-muted mb-3">{fileName}</p>
						<a href={rawUrl} download={fileName} class="px-4 py-2 rounded bg-hub-cta text-white text-sm hover:brightness-110 transition-all">Download PDF</a>
					</div>
				</div>
			{:else if isCsv && content}
				{@const rows = parseCsv(content)}
				<div class="overflow-auto h-full">
					<table class="w-full text-xs font-mono">
						{#if rows.length > 0}
							<thead class="sticky top-0">
								<tr>
									{#each rows[0] as header}
										<th class="px-3 py-1.5 text-left text-hub-dim bg-hub-surface font-medium border-b border-hub-border/50">{header}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each rows.slice(1) as row, i}
									<tr class="{i % 2 === 0 ? 'bg-hub-bg/30' : ''}">
										{#each row as cell}
											<td class="px-3 py-1 text-hub-text border-b border-hub-border/20">{cell}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						{/if}
					</table>
					{#if rows.length > 50}
						<div class="px-3 py-1.5 text-[10px] text-hub-dim bg-hub-surface border-t border-hub-border/30">
							Showing first 50 rows
						</div>
					{/if}
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
