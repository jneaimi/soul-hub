import { readFile, writeFile, stat, readdir, rename, mkdir } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { parseNote } from './parser.js';
import { WikilinkResolver } from './resolver.js';
import type { VaultNote, ParsedNote, VaultStats, VaultHealth } from './types.js';
import { IGNORED_FOLDERS, MAX_NOTE_SIZE, DEFAULT_ZONE } from './types.js';

export class VaultIndexer {
	private notes = new Map<string, VaultNote>();
	private mtimeCache = new Map<string, number>();
	private resolver = new WikilinkResolver();
	private lastIndexed = '';
	private vaultRoot: string;

	constructor(vaultRoot: string) {
		this.vaultRoot = vaultRoot;
	}

	async scan(): Promise<void> {
		const cachePath = resolve(this.vaultRoot, '.vault', 'mtime-cache.json');
		await this.loadCache(cachePath);

		const mdFiles = await this.walkMarkdown(this.vaultRoot);
		const relPaths: string[] = [];

		for (const absPath of mdFiles) {
			const relPath = relative(this.vaultRoot, absPath);
			relPaths.push(relPath);

			try {
				const fileStat = await stat(absPath);
				const mtime = fileStat.mtimeMs;

				if (this.mtimeCache.get(relPath) === mtime && this.notes.has(relPath)) {
					continue;
				}

				const raw = await readFile(absPath, 'utf-8');
				if (raw.length > MAX_NOTE_SIZE) {
					console.warn(`[vault/indexer] Skipped oversize file (${(raw.length / 1024).toFixed(0)} KB): ${relPath}`);
					continue;
				}

				const parsed = parseNote(relPath, raw);
				this.notes.set(relPath, {
					path: relPath,
					title: parsed.title,
					meta: parsed.meta,
					content: parsed.content,
					links: parsed.links,
					backlinks: [],
					mtime,
					size: fileStat.size,
				});
				this.mtimeCache.set(relPath, mtime);
			} catch {
				// skip unreadable files
			}
		}

		// Remove notes that no longer exist on disk
		const pathSet = new Set(relPaths);
		for (const key of this.notes.keys()) {
			if (!pathSet.has(key)) {
				this.notes.delete(key);
				this.mtimeCache.delete(key);
			}
		}

		this.resolver.build(relPaths);
		this.resolveAllLinks();
		this.computeBacklinks();
		await this.saveCache(cachePath);
		this.lastIndexed = new Date().toISOString();
	}

	async reindex(relPath: string): Promise<void> {
		const absPath = resolve(this.vaultRoot, relPath);

		try {
			const fileStat = await stat(absPath);
			const raw = await readFile(absPath, 'utf-8');
			if (raw.length > MAX_NOTE_SIZE) {
				console.warn(`[vault/indexer] Skipped oversize file (${(raw.length / 1024).toFixed(0)} KB): ${relPath}`);
				return;
			}

			const parsed = parseNote(relPath, raw);
			this.notes.set(relPath, {
				path: relPath,
				title: parsed.title,
				meta: parsed.meta,
				content: parsed.content,
				links: parsed.links,
				backlinks: [],
				mtime: fileStat.mtimeMs,
				size: fileStat.size,
			});
			this.mtimeCache.set(relPath, fileStat.mtimeMs);
			this.resolver.add(relPath);

			// Re-resolve links for this note
			const note = this.notes.get(relPath)!;
			for (const link of note.links) {
				link.resolved = this.resolver.resolve(link.raw);
			}

			this.computeBacklinks();

			const cachePath = resolve(this.vaultRoot, '.vault', 'mtime-cache.json');
			await this.saveCache(cachePath);
		} catch {
			// file may have been deleted between event and reindex
		}
	}

	remove(relPath: string): void {
		this.notes.delete(relPath);
		this.mtimeCache.delete(relPath);
		this.resolver.remove(relPath);
		this.computeBacklinks();
	}

	get(relPath: string): VaultNote | undefined {
		return this.notes.get(relPath);
	}

	all(): VaultNote[] {
		return Array.from(this.notes.values());
	}

	filter(opts: { zone?: string; type?: string; project?: string }): VaultNote[] {
		let notes = this.all();

		if (opts.zone) {
			notes = notes.filter((n) => this.getZone(n.path) === opts.zone);
		}
		if (opts.type) {
			notes = notes.filter((n) => n.meta.type === opts.type);
		}
		if (opts.project) {
			notes = notes.filter((n) => n.meta.project === opts.project);
		}

		return notes;
	}

	stats(): VaultStats {
		const allNotes = this.all();
		const notesByType: Record<string, number> = {};
		const notesByZone: Record<string, number> = {};
		let totalLinks = 0;
		let unresolvedLinks = 0;
		const ORPHAN_EXEMPT = new Set(['inbox', 'archive']);
		const orphanNotes = allNotes.filter((n) => {
			if (n.links.length > 0 || n.backlinks.length > 0) return false;
			const zone = n.path.split('/')[0];
			if (ORPHAN_EXEMPT.has(zone)) return false;
			if (n.path.endsWith('/index.md') || n.path === 'index.md') return false;
			if (n.meta.type === 'session-log') return false;
			return true;
		}).length;

		for (const note of allNotes) {
			const type = note.meta.type || 'unknown';
			notesByType[type] = (notesByType[type] || 0) + 1;

			const zone = this.getZone(note.path);
			notesByZone[zone] = (notesByZone[zone] || 0) + 1;

			totalLinks += note.links.length;
			unresolvedLinks += note.links.filter((l) => l.resolved === null).length;
		}

		return {
			totalNotes: allNotes.length,
			notesByType,
			notesByZone,
			totalLinks,
			unresolvedLinks,
			orphanNotes,
			lastIndexed: this.lastIndexed,
		};
	}

	health(): VaultHealth {
		const allNotes = this.all();
		const ORPHAN_EXEMPT = new Set(['inbox', 'archive']);
		const orphanNotes = allNotes
			.filter((n) => {
				if (n.links.length > 0 || n.backlinks.length > 0) return false;
				const zone = n.path.split('/')[0];
				if (ORPHAN_EXEMPT.has(zone)) return false;
				if (n.path.endsWith('/index.md') || n.path === 'index.md') return false;
				if (n.meta.type === 'session-log') return false;
				return true;
			})
			.map((n) => n.path);

		const unresolvedLinks: { source: string; raw: string }[] = [];
		for (const note of allNotes) {
			for (const link of note.links) {
				if (link.resolved === null) {
					unresolvedLinks.push({ source: note.path, raw: link.raw });
				}
			}
		}

		return {
			indexed: allNotes.length,
			staleFiles: [],
			orphanNotes,
			unresolvedLinks,
			lastIndexed: this.lastIndexed,
		};
	}

	getZone(relPath: string): string {
		const first = relPath.split('/')[0];
		if (relPath.split('/').length === 1) return DEFAULT_ZONE;
		return first || DEFAULT_ZONE;
	}

	private computeBacklinks(): void {
		// Clear all backlinks
		for (const note of this.notes.values()) {
			note.backlinks = [];
		}

		// Recompute
		for (const note of this.notes.values()) {
			for (const link of note.links) {
				if (link.resolved) {
					const target = this.notes.get(link.resolved);
					if (target && !target.backlinks.includes(note.path)) {
						target.backlinks.push(note.path);
					}
				}
			}
		}
	}

	private resolveAllLinks(): void {
		for (const note of this.notes.values()) {
			for (const link of note.links) {
				link.resolved = this.resolver.resolve(link.raw);
			}
		}
	}

	private async loadCache(cachePath: string): Promise<void> {
		try {
			const raw = await readFile(cachePath, 'utf-8');
			const data = JSON.parse(raw) as Record<string, number>;
			this.mtimeCache.clear();
			for (const [path, mtime] of Object.entries(data)) {
				this.mtimeCache.set(path, mtime);
			}
		} catch {
			// no cache file — fresh scan
		}
	}

	private async saveCache(cachePath: string): Promise<void> {
		const obj: Record<string, number> = {};
		for (const [path, mtime] of this.mtimeCache) {
			obj[path] = mtime;
		}
		try {
			const dir = dirname(cachePath);
			await mkdir(dir, { recursive: true });
			const tmpPath = cachePath + '.tmp';
			await writeFile(tmpPath, JSON.stringify(obj, null, 2));
			await rename(tmpPath, cachePath);
		} catch {
			// non-critical — cache miss on next startup
		}
	}

	private async walkMarkdown(root: string): Promise<string[]> {
		const ignoredSet = new Set(IGNORED_FOLDERS);
		const results: string[] = [];

		const entries = await readdir(root, { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith('.md')) continue;
			if (entry.name === 'CLAUDE.md') continue; // governance files, not notes

			// Build the relative path from root
			const parentPath = entry.parentPath ?? (entry as unknown as { path: string }).path ?? '';
			const absPath = join(parentPath, entry.name);
			const relFromRoot = relative(root, absPath);

			// Check if any path segment is in the ignored set
			const segments = relFromRoot.split('/');
			if (segments.some((seg) => ignoredSet.has(seg))) continue;

			results.push(absPath);
		}

		return results;
	}
}
