import { resolve, join, dirname } from 'node:path';
import { readFile, writeFile, rename, stat, mkdir, unlink } from 'node:fs/promises';
import matter from 'gray-matter';
import type {
	VaultNote, VaultConfig, SearchQuery, SearchResult,
	GraphData, VaultStats, VaultHealth, VaultZone, VaultTemplate,
	CreateNoteRequest, UpdateNoteRequest, WriteResult, WriteError
} from './types.js';
import { GLOBAL_REQUIRED_FIELDS, MAX_NOTE_SIZE } from './types.js';
import { VaultIndexer } from './indexer.js';
import { VaultSearch } from './search.js';
import { VaultGraph } from './graph.js';
import { VaultWatcher } from './watcher.js';
import { GovernanceResolver } from './governance.js';
import { TemplateLoader } from './templates.js';

let engine: VaultEngine | null = null;

export class VaultEngine {
	private indexer: VaultIndexer;
	private searcher: VaultSearch;
	private graph: VaultGraph;
	private watcher: VaultWatcher;
	private governance: GovernanceResolver;
	private templates: TemplateLoader;
	private config: VaultConfig;
	private pruneInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: VaultConfig) {
		this.config = config;
		this.indexer = new VaultIndexer(config.rootDir);
		this.searcher = new VaultSearch();
		this.graph = new VaultGraph();
		this.watcher = new VaultWatcher();
		this.governance = new GovernanceResolver();
		this.templates = new TemplateLoader();
	}

	async init(): Promise<void> {
		await this.governance.scan(this.config.rootDir);
		await this.templates.load(this.config.templateDir);
		await this.indexer.scan();
		this.searcher.rebuild(this.indexer.all());

		this.watcher.start(this.config.rootDir, async (event) => {
			if (event.type === 'add' || event.type === 'change') {
				await this.indexer.reindex(event.path);
				const note = this.indexer.get(event.path);
				if (note) this.searcher.upsert(note);
			} else if (event.type === 'unlink') {
				this.indexer.remove(event.path);
				this.searcher.remove(event.path);
			}
		});

		// Prune ephemeral zones on startup, then every 24 hours
		const runPrune = async () => {
			await this.pruneZone('sessions', 7).catch(() => {});
			await this.pruneZone('operations', 7, 'session-log').catch(() => {});
			await this.archiveOldNotes('inbox', 30).catch(() => {});
			await this.pruneZone('archive', 90).catch(() => {});
		};
		runPrune();
		this.pruneInterval = setInterval(runPrune, 24 * 60 * 60 * 1000);

		console.log(`[vault] Initialized: ${this.indexer.all().length} notes indexed`);
	}

	shutdown(): void {
		this.watcher.stop();
		if (this.pruneInterval) clearInterval(this.pruneInterval);
	}

	// ── Read Operations ──

	getNote(path: string): VaultNote | undefined {
		return this.indexer.get(path);
	}

	getNotes(query: SearchQuery): SearchResult[] {
		return this.searcher.search(query);
	}

	getGraph(opts?: { zone?: string; project?: string }): GraphData {
		const notes = opts ? this.indexer.filter(opts) : this.indexer.all();
		return this.graph.build(notes);
	}

	getLocalGraph(path: string, depth?: number): GraphData {
		return this.graph.local(this.indexer.all(), path, depth);
	}

	getBacklinks(path: string): VaultNote[] {
		const note = this.indexer.get(path);
		if (!note) return [];
		return note.backlinks
			.map((bl) => this.indexer.get(bl))
			.filter((n): n is VaultNote => n !== undefined);
	}

	getTags(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const note of this.indexer.all()) {
			for (const tag of note.meta.tags ?? []) {
				counts[tag] = (counts[tag] || 0) + 1;
			}
		}
		return counts;
	}

	getRecent(limit = 20): VaultNote[] {
		return this.indexer
			.all()
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit);
	}

	getOrphans(): VaultNote[] {
		return this.indexer
			.all()
			.filter((n) => n.links.length === 0 && n.backlinks.length === 0);
	}

	getUnresolved(): { source: string; raw: string }[] {
		const results: { source: string; raw: string }[] = [];
		for (const note of this.indexer.all()) {
			for (const link of note.links) {
				if (link.resolved === null) {
					results.push({ source: note.path, raw: link.raw });
				}
			}
		}
		return results;
	}

	getStats(): VaultStats {
		return this.indexer.stats();
	}

	getHealth(): VaultHealth {
		return this.indexer.health();
	}

	getGovernanceViolations(): { path: string; violations: string[] }[] {
		const results: { path: string; violations: string[] }[] = [];
		for (const note of this.indexer.all()) {
			const violations: string[] = [];
			const zone = this.governance.resolve(note.path.split('/').slice(0, -1).join('/'));

			// Check type allowed
			if (zone.allowedTypes.length > 0 && note.meta.type && !zone.allowedTypes.includes(note.meta.type)) {
				violations.push(`Type "${note.meta.type}" not allowed (allowed: ${zone.allowedTypes.join(', ')})`);
			}

			// Check required fields
			for (const field of zone.requiredFields) {
				if (!(field in note.meta) || note.meta[field] === undefined || note.meta[field] === '') {
					violations.push(`Missing required field: ${field}`);
				}
			}

			if (violations.length > 0) {
				results.push({ path: note.path, violations });
			}
		}

		// Check for orphan notes (no incoming or outgoing links) — skip inbox and archive
		const orphanExemptZones = ['inbox', 'archive'];
		for (const note of this.indexer.all()) {
			const zone = note.path.split('/')[0];
			if (orphanExemptZones.includes(zone)) continue;
			if (note.links.length === 0 && note.backlinks.length === 0) {
				const existing = results.find(r => r.path === note.path);
				if (existing) {
					existing.violations.push('No wikilinks (orphan note — add at least one [[link]])');
				} else {
					results.push({ path: note.path, violations: ['No wikilinks (orphan note — add at least one [[link]])'] });
				}
			}
		}

		return results;
	}

	getZones(): VaultZone[] {
		return this.governance.getZones();
	}

	getTemplates(): VaultTemplate[] {
		return this.templates.list();
	}

	async saveTemplate(name: string, raw: string): Promise<VaultTemplate> {
		return this.templates.save(name, raw);
	}

	async deleteTemplate(name: string): Promise<boolean> {
		return this.templates.remove(name);
	}

	// ── Write Operations ──

	async createNote(req: CreateNoteRequest): Promise<WriteResult | WriteError> {
		// Validate global required fields
		for (const field of GLOBAL_REQUIRED_FIELDS) {
			if (!(field in req.meta) || req.meta[field] === undefined || req.meta[field] === '') {
				return { success: false, error: `Missing required field: ${field}`, field };
			}
		}

		// Validate against zone governance
		const zone = this.governance.resolve(req.zone);
		if (zone.allowedTypes.length > 0 && req.meta.type && !zone.allowedTypes.includes(req.meta.type)) {
			return { success: false, error: `Type "${req.meta.type}" not allowed in zone "${req.zone}". Allowed: ${zone.allowedTypes.join(', ')}` };
		}
		for (const field of zone.requiredFields) {
			if (!(field in req.meta) || req.meta[field] === undefined || req.meta[field] === '') {
				return { success: false, error: `Zone "${req.zone}" requires field: ${field}`, field };
			}
		}

		// Validate naming pattern
		if (zone.namingPattern) {
			const re = new RegExp(zone.namingPattern);
			if (!re.test(req.filename)) {
				return { success: false, error: `Filename "${req.filename}" doesn't match zone naming pattern: ${zone.namingPattern}` };
			}
		}

		// Validate against template if required
		if (zone.requireTemplate && req.meta.type) {
			const validation = this.templates.validate(req.meta.type, req.content, true);
			if (!validation.valid) {
				return { success: false, error: `Missing template sections: ${validation.missing.join(', ')}` };
			}
		}

		// Validate file size
		// Auto-tag agent-generated notes
		if (req.meta.source_agent && !req.meta.tags?.includes('auto-generated')) {
			req.meta.tags = [...(req.meta.tags ?? []), 'auto-generated'];
		}

		const content = matter.stringify(req.content, req.meta);
		if (Buffer.byteLength(content) > MAX_NOTE_SIZE) {
			return { success: false, error: `Note exceeds maximum size of ${MAX_NOTE_SIZE} bytes` };
		}

		const relPath = join(req.zone, req.filename);
		const absPath = resolve(this.config.rootDir, relPath);

		// Check file doesn't already exist
		try {
			await stat(absPath);
			return { success: false, error: `File already exists: ${relPath}` };
		} catch {
			// good — file doesn't exist
		}

		// Suppress watcher for this path (we'll reindex explicitly)
		this.watcher.suppress(relPath);

		// Atomic write: write to tmp, then rename
		try {
			await mkdir(dirname(absPath), { recursive: true });
			const tmpPath = absPath + '.tmp';
			await writeFile(tmpPath, content, 'utf-8');
			await rename(tmpPath, absPath);
		} catch (err) {
			return { success: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		await this.indexer.reindex(relPath);
		const note = this.indexer.get(relPath);
		if (note) this.searcher.upsert(note);

		return { success: true, path: relPath };
	}

	async updateNote(path: string, req: UpdateNoteRequest): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		const mergedMeta = { ...existing.meta, ...(req.meta ?? {}) };
		const newContent = req.content ?? existing.content;

		// Re-validate
		for (const field of GLOBAL_REQUIRED_FIELDS) {
			if (!(field in mergedMeta) || mergedMeta[field] === undefined || mergedMeta[field] === '') {
				return { success: false, error: `Missing required field: ${field}`, field };
			}
		}

		const content = matter.stringify(newContent, mergedMeta);
		if (Buffer.byteLength(content) > MAX_NOTE_SIZE) {
			return { success: false, error: `Note exceeds maximum size of ${MAX_NOTE_SIZE} bytes` };
		}

		this.watcher.suppress(path);

		const absPath = resolve(this.config.rootDir, path);
		try {
			const tmpPath = absPath + '.tmp';
			await writeFile(tmpPath, content, 'utf-8');
			await rename(tmpPath, absPath);
		} catch (err) {
			return { success: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		await this.indexer.reindex(path);
		const note = this.indexer.get(path);
		if (note) this.searcher.upsert(note);

		return { success: true, path };
	}

	async archiveNote(path: string): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		const filename = path.split('/').pop()!;
		const archivePath = join('archive', filename);
		const absSource = resolve(this.config.rootDir, path);
		const absTarget = resolve(this.config.rootDir, archivePath);

		try {
			await mkdir(dirname(absTarget), { recursive: true });
			await rename(absSource, absTarget);
		} catch (err) {
			return { success: false, error: `Archive failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		this.indexer.remove(path);
		this.searcher.remove(path);
		await this.indexer.reindex(archivePath);
		const note = this.indexer.get(archivePath);
		if (note) this.searcher.upsert(note);

		return { success: true, path: archivePath };
	}

	async moveNote(path: string, targetZone: string): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		// Validate against target zone governance
		const zone = this.governance.resolve(targetZone);
		if (zone.allowedTypes.length > 0 && existing.meta.type && !zone.allowedTypes.includes(existing.meta.type)) {
			return { success: false, error: `Type "${existing.meta.type}" not allowed in zone "${targetZone}"` };
		}

		const filename = path.split('/').pop()!;
		const newPath = join(targetZone, filename);
		const absSource = resolve(this.config.rootDir, path);
		const absTarget = resolve(this.config.rootDir, newPath);

		try {
			await mkdir(dirname(absTarget), { recursive: true });
			await rename(absSource, absTarget);
		} catch (err) {
			return { success: false, error: `Move failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		this.indexer.remove(path);
		this.searcher.remove(path);
		await this.indexer.reindex(newPath);
		const note = this.indexer.get(newPath);
		if (note) this.searcher.upsert(note);

		return { success: true, path: newPath };
	}

	async reindex(): Promise<VaultStats> {
		await this.indexer.scan();
		this.searcher.rebuild(this.indexer.all());
		return this.indexer.stats();
	}

	/**
	 * Delete notes in a zone older than maxAgeDays.
	 * Used for ephemeral zones like sessions/ that auto-cleanup.
	 */
	async pruneZone(zone: string, maxAgeDays: number, typeFilter?: string): Promise<{ pruned: string[] }> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const pruned: string[] = [];

		const notes = this.indexer.filter({ zone });
		for (const note of notes) {
			if (note.mtime < cutoff) {
				// If typeFilter specified, only prune notes of that type
				if (typeFilter && note.meta.type !== typeFilter) continue;

				const absPath = resolve(this.config.rootDir, note.path);
				try {
					await unlink(absPath);
					this.indexer.remove(note.path);
					this.searcher.remove(note.path);
					pruned.push(note.path);
				} catch {
					// file may already be gone
				}
			}
		}

		if (pruned.length > 0) {
			console.log(`[vault] Pruned ${pruned.length} notes from ${zone}/ (older than ${maxAgeDays} days)`);
		}

		return { pruned };
	}

	async archiveOldNotes(zone: string, maxAgeDays: number): Promise<{ archived: string[] }> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const archived: string[] = [];

		const notes = this.indexer.filter({ zone });
		for (const note of notes) {
			if (note.mtime < cutoff) {
				const result = await this.moveNote(note.path, 'archive');
				if (result.success) {
					archived.push(note.path);
				}
			}
		}

		if (archived.length > 0) {
			console.log(`[vault] Archived ${archived.length} notes from ${zone}/ (older than ${maxAgeDays} days)`);
		}

		return { archived };
	}

	async scaffoldProject(projectName: string): Promise<{ created: string[]; existed: string[] }> {
		const created: string[] = [];
		const existed: string[] = [];
		const projectZone = `projects/${projectName}`;
		const absBase = resolve(this.config.rootDir, projectZone);

		// Create subfolders
		const subfolders = ['decisions', 'learnings', 'debugging', 'outputs'];
		for (const sub of subfolders) {
			const dir = resolve(absBase, sub);
			try {
				await stat(dir);
				existed.push(`${projectZone}/${sub}/`);
			} catch {
				await mkdir(dir, { recursive: true });
				created.push(`${projectZone}/${sub}/`);
			}
		}

		// Create CLAUDE.md if not exists
		const claudePath = resolve(absBase, 'CLAUDE.md');
		try {
			await stat(claudePath);
			existed.push(`${projectZone}/CLAUDE.md`);
		} catch {
			const governance = `# ${projectName} — Vault Governance

## Allowed Types
learning, decision, debugging, output, index

## Required Fields
type, created, tags, project

## Quality Rules
- Decisions must have: Status, Context, Decision, Consequences sections
- Learnings must reference source (commit, conversation, pipeline)
- Debugging notes must have: Symptom, Root Cause, Fix, Prevention sections
- All notes must include project: ${projectName} in frontmatter

## AI Write Rules
- Agent outputs go to outputs/ subfolder
- Never overwrite existing notes — create new

## Before You Build
Search the vault for relevant knowledge before starting work:
\`\`\`bash
curl -s "http://localhost:2400/api/vault/notes?project=${projectName}&limit=10"
curl -s "http://localhost:2400/api/vault/notes?q=<your-topic>&limit=5"
\`\`\`
Check: patterns (reusable solutions), decisions (why things are the way they are), debugging (known pitfalls).

## After You Build
Save valuable knowledge:
- **Reusable pattern** → POST to /api/vault/notes with zone "patterns"
- **Design decision** → POST with zone "projects/${projectName}/decisions"
- **Surprising learning** → POST with zone "projects/${projectName}/learnings"
- **Bug investigation** → POST with zone "projects/${projectName}/debugging"
`;
			await writeFile(claudePath, governance, 'utf-8');
			created.push(`${projectZone}/CLAUDE.md`);
		}

		// Create index.md if not exists
		const indexPath = resolve(absBase, 'index.md');
		try {
			await stat(indexPath);
			existed.push(`${projectZone}/index.md`);
		} catch {
			const today = new Date().toISOString().slice(0, 10);
			const index = `---
type: index
created: ${today}
tags: [${projectName}]
project: ${projectName}
---

# ${projectName}

## Decisions

## Learnings

## Debugging

## Outputs
`;
			await writeFile(indexPath, index, 'utf-8');
			created.push(`${projectZone}/index.md`);
			// Reindex to pick up the new note
			await this.indexer.reindex(`${projectZone}/index.md`);
			const note = this.indexer.get(`${projectZone}/index.md`);
			if (note) this.searcher.upsert(note);
		}

		// Re-scan governance to pick up new CLAUDE.md
		await this.governance.scan(this.config.rootDir);

		return { created, existed };
	}
}

export function getVaultEngine(): VaultEngine | null {
	return engine;
}

export async function initVault(vaultDir: string): Promise<VaultEngine> {
	if (engine) return engine;
	// Ensure vault root exists — fresh installs won't have it
	await mkdir(vaultDir, { recursive: true });
	const config: VaultConfig = {
		rootDir: vaultDir,
		templateDir: resolve(vaultDir, '.vault', 'templates'),
		indexPath: resolve(vaultDir, '.vault', 'index.json'),
		zones: [],
	};
	const instance = new VaultEngine(config);
	await instance.init();
	engine = instance; // Only expose after init completes
	return engine;
}
