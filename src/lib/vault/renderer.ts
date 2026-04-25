import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypePrettyCode from 'rehype-pretty-code';
import { visit } from 'unist-util-visit';

/**
 * Post-process HTML string to convert [[wikilinks]] to clickable elements.
 * Runs AFTER rehype-stringify since wikilinks are not standard markdown.
 */
function processWikilinks(html: string): string {
	return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, target, alias) => {
		const display = alias || target;
		return `<a class="vault-wikilink" data-target="${target}" href="javascript:void(0)">${display}</a>`;
	});
}

function rehypeMediaResolver(options: { vaultDir: string; noteDir: string }) {
	return (tree: any) => {
		visit(tree, 'element', (node: any) => {
			if (node.tagName === 'img' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'video' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'audio' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'source' && node.properties?.src) {
				node.properties.src = resolveMediaSrc(node.properties.src, options);
			}
			if (node.tagName === 'a' && node.properties?.href) {
				rewriteAttachmentLink(node, options);
			}
		});
	};
}

function resolveMediaSrc(src: string, opts: { vaultDir: string; noteDir: string }): string {
	if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/api/')) return src;
	if (!opts.vaultDir) return src;
	const fullDir = opts.noteDir ? `${opts.vaultDir}/${opts.noteDir}` : opts.vaultDir;
	return `/api/files?path=${encodeURIComponent(fullDir)}&action=raw&file=${encodeURIComponent(src)}`;
}

/**
 * Rewrite relative `<a href>` targets that point to sibling non-markdown files
 * so they resolve through /api/files and carry metadata for click interception.
 * Markdown-to-markdown links, external URLs, anchors, and wikilinks are left alone.
 */
function rewriteAttachmentLink(node: any, opts: { vaultDir: string; noteDir: string }): void {
	const href = node.properties.href;
	if (typeof href !== 'string' || !href) return;
	if (href.startsWith('http://') || href.startsWith('https://')) return;
	if (href.startsWith('/')) return;
	if (href.startsWith('#')) return;
	if (href.startsWith('javascript:') || href.startsWith('mailto:')) return;

	const [pathPart] = href.split('#');
	const [cleanPath] = pathPart.split('?');
	if (!cleanPath) return;
	if (/\.(md|mdx)$/i.test(cleanPath)) return; // markdown targets handled by the note router

	if (!opts.vaultDir) return;

	const normalized = cleanPath.startsWith('./') ? cleanPath.slice(2) : cleanPath;
	const filename = normalized.split('/').pop();
	if (!filename) return;
	const subDir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
	const noteAbsDir = opts.noteDir ? `${opts.vaultDir}/${opts.noteDir}` : opts.vaultDir;
	const absDir = subDir ? `${noteAbsDir}/${subDir}` : noteAbsDir;
	const absPath = `${absDir}/${filename}`;

	node.properties.href = `/api/files?path=${encodeURIComponent(absDir)}&action=raw&file=${encodeURIComponent(filename)}`;
	node.properties['data-vault-attachment'] = 'true';
	node.properties['data-vault-attachment-path'] = absPath;
	node.properties['data-vault-attachment-name'] = filename;
	const existingClasses = Array.isArray(node.properties.className)
		? node.properties.className
		: node.properties.className
			? [node.properties.className]
			: [];
	node.properties.className = [...existingClasses, 'vault-attachment-link'];
}

function rehypeCodeCopyButton() {
	return (tree: any) => {
		visit(tree, 'element', (node: any, index: number | undefined, parent: any) => {
			if (node.tagName !== 'pre') return;
			const codeEl = node.children?.find((c: any) => c.tagName === 'code');
			if (!codeEl) return;

			const langClass = (codeEl.properties?.className || []).find((c: string) =>
				typeof c === 'string' && c.startsWith('language-')
			);
			const lang = langClass ? langClass.replace('language-', '') : '';

			const wrapper = {
				type: 'element',
				tagName: 'div',
				properties: { className: ['vault-code-block'], 'data-lang': lang },
				children: [
					{
						type: 'element',
						tagName: 'div',
						properties: { className: ['vault-code-header'] },
						children: [
							{
								type: 'element',
								tagName: 'span',
								properties: { className: ['vault-code-lang'] },
								children: [{ type: 'text', value: lang }],
							},
							{
								type: 'element',
								tagName: 'button',
								properties: {
									className: ['vault-code-copy'],
									onclick:
										"navigator.clipboard.writeText(this.closest('.vault-code-block').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy'},1500)})",
								},
								children: [{ type: 'text', value: 'Copy' }],
							},
						],
					},
					node,
				],
			};

			if (parent && typeof index === 'number') {
				parent.children[index] = wrapper;
			}
		});
	};
}

export async function renderMarkdown(
	content: string,
	options: { vaultDir: string; noteDir: string }
): Promise<string> {
	if (!content || !content.trim()) return '';

	const result = await unified()
		.use(remarkParse)
		.use(remarkFrontmatter, ['yaml'])
		.use(remarkGfm)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypePrettyCode, { theme: 'github-dark-default', keepBackground: true })
		.use(rehypeCodeCopyButton)
		.use(rehypeMediaResolver, options)
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(content);

	let html = String(result);

	// Strip leading <h1> — title is already shown in the metadata header
	html = html.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/, '');

	// Wikilinks are processed as a post-pass on the HTML string
	// since [[target|alias]] is not standard markdown syntax
	return processWikilinks(html);
}

export function isRtl(text: string): boolean {
	const rtlChars = text.match(
		/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/g
	);
	if (!rtlChars) return false;
	const latinChars = text.match(/[a-zA-Z]/g);
	const totalAlpha = (rtlChars?.length || 0) + (latinChars?.length || 0);
	return totalAlpha > 0 && rtlChars.length / totalAlpha > 0.3;
}
