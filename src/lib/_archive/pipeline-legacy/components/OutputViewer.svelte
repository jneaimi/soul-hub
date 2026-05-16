<script lang="ts">
	import { marked } from 'marked';

	export interface OutputEntry {
		name: string;
		path: string;
		type: string;
		format?: string;
		status?: string;
		/** Vault note path from pipeline-bridge (e.g. projects/my-pipeline/outputs/2026-04-14-step-abc.md) */
		vaultNotePath?: string;
	}

	interface Props {
		outputs: OutputEntry[];
		onPreview?: (path: string, name: string) => void;
	}

	let { outputs, onPreview }: Props = $props();

	let expandedPreviews = $state<Set<string>>(new Set());
	let previewContent = $state<Record<string, string>>({});
	let previewLoading = $state<Set<string>>(new Set());

	function isPreviewable(entry: OutputEntry): boolean {
		if (entry.type === 'file') {
			return ['json', 'markdown', 'csv', 'text', 'html'].includes(entry.format || '');
		}
		return false;
	}

	function isMedia(entry: OutputEntry): boolean {
		if (entry.type !== 'file') return false;
		const f = entry.format || '';
		return f.startsWith('image/') || f.startsWith('video/') || f.startsWith('audio/');
	}

	function isDownloadable(entry: OutputEntry): boolean {
		return entry.type === 'file';
	}

	function isActionType(entry: OutputEntry): boolean {
		return ['log', 'channel', 'db-write', 'api-push', 'webhook'].includes(entry.type);
	}

	function getMediaType(format: string): 'image' | 'video' | 'audio' | null {
		if (format.startsWith('image/')) return 'image';
		if (format.startsWith('video/')) return 'video';
		if (format.startsWith('audio/')) return 'audio';
		return null;
	}

	async function togglePreview(entry: OutputEntry) {
		const key = entry.path;
		if (expandedPreviews.has(key)) {
			expandedPreviews = new Set([...expandedPreviews].filter(k => k !== key));
			return;
		}

		// Use FilePreview slide-over for complex types
		if (onPreview && (entry.format === 'json' || entry.format === 'markdown' || entry.format === 'text')) {
			onPreview(entry.path, entry.name);
			return;
		}

		// Inline preview for CSV
		if (entry.format === 'csv' && !previewContent[key]) {
			previewLoading = new Set([...previewLoading, key]);
			try {
				const dir = entry.path.substring(0, entry.path.lastIndexOf('/'));
				const file = entry.path.substring(entry.path.lastIndexOf('/') + 1);
				const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}&action=read&file=${encodeURIComponent(file)}`);
				if (res.ok) {
					const data = await res.json();
					previewContent = { ...previewContent, [key]: data.content };
				}
			} catch { /* ignore */ }
			previewLoading = new Set([...previewLoading].filter(k => k !== key));
		}

		expandedPreviews = new Set([...expandedPreviews, key]);
	}

	function parseCsv(raw: string): string[][] {
		const lines = raw.trim().split('\n');
		return lines.slice(0, 21).map(line => line.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
	}

	function renderMarkdownInline(md: string): string {
		return marked.parse(md, { async: false }) as string;
	}

	function getDownloadUrl(path: string): string {
		const dir = path.substring(0, path.lastIndexOf('/'));
		const file = path.substring(path.lastIndexOf('/') + 1);
		return `/api/files?path=${encodeURIComponent(dir)}&action=raw&file=${encodeURIComponent(file)}`;
	}

	function statusBadgeClass(status: string | undefined): string {
		if (!status) return 'bg-hub-dim/20 text-hub-dim';
		if (status === 'sent' || status === 'success' || (status.startsWith('2'))) return 'bg-hub-cta/15 text-hub-cta';
		return 'bg-hub-danger/15 text-hub-danger';
	}

	function statusLabel(entry: OutputEntry): string {
		const s = entry.status || 'unknown';
		switch (entry.type) {
			case 'channel': return s === 'sent' ? 'sent' : 'failed';
			case 'db-write': return s;
			case 'api-push':
			case 'webhook': return s;
			default: return s;
		}
	}
</script>

{#if outputs.length > 0}
<section class="mt-6">
	<h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Pipeline Outputs</h3>
	<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden divide-y divide-hub-border/30">
		{#each outputs as entry (entry.path)}
			{@const mediaType = entry.format ? getMediaType(entry.format) : null}
			<div class="group">
				<div class="flex items-center gap-3 px-4 py-2.5">
					<!-- Type icon -->
					<div class="flex-shrink-0 w-5 h-5 text-hub-muted">
						{#if entry.type === 'file' && mediaType === 'image'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>
							</svg>
						{:else if entry.type === 'file' && mediaType === 'video'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="m10 8 6 4-6 4z"/>
							</svg>
						{:else if entry.type === 'file' && mediaType === 'audio'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
							</svg>
						{:else if entry.type === 'log'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
							</svg>
						{:else if entry.type === 'channel'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
							</svg>
						{:else if entry.type === 'db-write'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
							</svg>
						{:else if entry.type === 'api-push' || entry.type === 'webhook'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-full h-full">
								<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
							</svg>
						{/if}
					</div>

					<!-- Name + format badge -->
					<div class="flex-1 min-w-0 flex items-center gap-2">
						<span class="text-sm text-hub-text truncate">{entry.name}</span>
						{#if entry.format}
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim font-mono flex-shrink-0">{entry.format}</span>
						{/if}
					</div>

					<!-- Actions / Status -->
					<div class="flex items-center gap-2 flex-shrink-0">
						{#if isActionType(entry)}
							<span class="text-[11px] px-2 py-0.5 rounded-full font-medium {statusBadgeClass(entry.status)}">
								{statusLabel(entry)}
							</span>
						{/if}

						{#if isMedia(entry) || isPreviewable(entry)}
							<button
								onclick={() => togglePreview(entry)}
								class="text-[11px] px-2.5 py-1 rounded border border-hub-border/50 text-hub-muted hover:text-hub-text hover:border-hub-border transition-colors cursor-pointer"
							>
								Preview
							</button>
						{/if}

						{#if isDownloadable(entry)}
							<a
								href={getDownloadUrl(entry.path)}
								download={entry.name}
								class="text-[11px] px-2.5 py-1 rounded border border-hub-border/50 text-hub-muted hover:text-hub-text hover:border-hub-border transition-colors"
							>
								Download
							</a>
						{/if}

						{#if entry.vaultNotePath}
							<a
								href="/vault?note={encodeURIComponent(entry.vaultNotePath)}"
								class="text-[11px] px-2.5 py-1 rounded border border-hub-border/50 text-hub-muted hover:text-hub-text hover:border-hub-border transition-colors"
								target="_blank"
							>
								Open in Vault
							</a>
						{/if}
					</div>
				</div>

				<!-- Inline preview area -->
				{#if expandedPreviews.has(entry.path)}
					<div class="border-t border-hub-border/30 bg-hub-bg/50">
						{#if entry.type === 'file' && mediaType === 'image'}
							<div class="p-4 flex justify-center">
								<img src={getDownloadUrl(entry.path)} alt={entry.name} class="max-w-full max-h-80 object-contain rounded" />
							</div>
						{:else if entry.type === 'file' && mediaType === 'video'}
							<div class="p-4 flex justify-center">
								<!-- svelte-ignore a11y_media_has_caption -->
								<video src={getDownloadUrl(entry.path)} controls class="max-w-full max-h-80 rounded"></video>
							</div>
						{:else if entry.type === 'file' && mediaType === 'audio'}
							<div class="p-4">
								<audio src={getDownloadUrl(entry.path)} controls class="w-full"></audio>
							</div>
						{:else if entry.format === 'csv' && previewContent[entry.path]}
							{@const rows = parseCsv(previewContent[entry.path])}
							<div class="overflow-x-auto max-h-80">
								<table class="w-full text-xs font-mono">
									{#if rows.length > 0}
										<thead>
											<tr>
												{#each rows[0] as header}
													<th class="px-3 py-1.5 text-left text-hub-dim bg-hub-surface font-medium border-b border-hub-border/50 sticky top-0">{header}</th>
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
								{#if rows.length > 20}
									<div class="px-3 py-1.5 text-[10px] text-hub-dim bg-hub-surface border-t border-hub-border/30">
										Showing first 20 rows
									</div>
								{/if}
							</div>
						{:else if entry.format === 'csv' && previewLoading.has(entry.path)}
							<div class="p-4 text-sm text-hub-dim">Loading...</div>
						{:else if entry.type === 'log'}
							<div class="p-4 max-h-80 overflow-auto">
								<pre class="text-xs font-mono text-hub-text whitespace-pre-wrap">{entry.status || 'No log content'}</pre>
							</div>
						{:else if entry.format === 'html'}
							<div class="px-4 py-2">
								<a href={getDownloadUrl(entry.path)} target="_blank" rel="noopener" class="text-sm text-hub-info hover:underline">Open in new tab</a>
							</div>
						{:else if entry.format === 'pdf'}
							<div class="px-4 py-2">
								<a href={getDownloadUrl(entry.path)} download={entry.name} class="text-sm text-hub-info hover:underline">Download PDF</a>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</section>
{/if}
