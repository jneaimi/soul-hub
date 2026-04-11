import matter from 'gray-matter';
import type { ParsedNote, VaultMeta, VaultLink } from './types.js';

const WIKILINK_RE = /(!?)\[\[([^\]|#^]+?)(?:#([^\]|]+?))?(?:\^([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

export function parseNote(filePath: string, raw: string): ParsedNote {
	const { data, content } = matter(raw);
	const meta = data as VaultMeta;
	const title =
		(typeof meta.title === 'string' && meta.title) ||
		extractFirstHeading(content) ||
		pathToTitle(filePath);

	return {
		title,
		meta,
		content,
		links: extractLinks(content)
	};
}

export function extractLinks(content: string): VaultLink[] {
	const links: VaultLink[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);

	while ((match = re.exec(content)) !== null) {
		links.push({
			raw: match[2].trim(),
			resolved: null,
			alias: match[5] || undefined,
			heading: match[3] || undefined,
			embed: match[1] === '!'
		});
	}

	return links;
}

export function extractFirstHeading(content: string): string | null {
	const match = /^#\s+(.+)$/m.exec(content);
	return match ? match[1].trim() : null;
}

export function pathToTitle(filePath: string): string {
	const basename = filePath.split('/').pop() ?? filePath;
	const withoutExt = basename.replace(/\.md$/i, '');
	const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, '');
	return withoutDate
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
