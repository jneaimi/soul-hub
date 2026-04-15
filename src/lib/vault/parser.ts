import matter from 'gray-matter';
import type { ParsedNote, VaultMeta, VaultLink } from './types.js';

// Wikilink content must not contain newlines (prevents false matches on escape sequences like ^[[...)
const WIKILINK_RE = /(!?)\[\[([^\]\n|#^]+?)(?:#([^\]\n|]+?))?(?:\^([^\]\n|]+?))?(?:\|([^\]\n]+?))?\]\]/g;

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

function extractLinks(content: string): VaultLink[] {
	const links: VaultLink[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);

	// Strip fenced code blocks and inline code so we don't parse example wikilinks
	const stripped = content
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`[^`]+`/g, '');

	while ((match = re.exec(stripped)) !== null) {
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

function extractFirstHeading(content: string): string | null {
	const match = /^#\s+(.+)$/m.exec(content);
	return match ? match[1].trim() : null;
}

function pathToTitle(filePath: string): string {
	const basename = filePath.split('/').pop() ?? filePath;
	const withoutExt = basename.replace(/\.md$/i, '');
	const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, '');
	return withoutDate
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
