/** Vault engine types — the knowledge layer for Soul Hub */

// ── Note Types ──────────────────────────────────────────────

export interface VaultNote {
	/** Relative path from vault root (e.g., "projects/soul-hub/decisions/pty-bridge.md") */
	path: string;
	/** Note title (from frontmatter title, first heading, or filename) */
	title: string;
	/** Parsed frontmatter fields */
	meta: VaultMeta;
	/** Raw markdown content (without frontmatter block) */
	content: string;
	/** Extracted outgoing wikilinks */
	links: VaultLink[];
	/** Computed backlinks — paths of notes that link TO this note */
	backlinks: string[];
	/** File modification time (ms since epoch) */
	mtime: number;
	/** File size in bytes */
	size: number;
}

export interface VaultMeta {
	type?: string;
	status?: string;
	created?: string;
	updated?: string;
	tags?: string[];
	project?: string;
	source?: string;
	language?: string;
	resolved?: boolean;
	/** Catch-all for custom frontmatter fields */
	[key: string]: unknown;
}

export interface VaultLink {
	/** Raw link text as written: "Some Note" or "folder/note" */
	raw: string;
	/** Resolved path relative to vault root (null if unresolved) */
	resolved: string | null;
	/** Display alias (from [[target|alias]]) */
	alias?: string;
	/** Heading anchor (from [[target#heading]]) */
	heading?: string;
	/** Whether this is an embed (![[...]]) */
	embed: boolean;
}

// ── Parsed Note (before indexing) ───────────────────────────

export interface ParsedNote {
	title: string;
	meta: VaultMeta;
	content: string;
	links: VaultLink[];
}

// ── Config & Governance ─────────────────────────────────────

export interface VaultConfig {
	/** Vault root directory (absolute path) */
	rootDir: string;
	/** Template directory (absolute path) */
	templateDir: string;
	/** Index cache file path */
	indexPath: string;
	/** Auto-discovered zone rules */
	zones: VaultZone[];
}

export interface VaultZone {
	/** Folder path relative to vault root */
	path: string;
	/** Allowed note types in this zone */
	allowedTypes: string[];
	/** Whether templates are required for writes */
	requireTemplate: boolean;
	/** Required frontmatter fields beyond the global defaults */
	requiredFields: string[];
	/** Naming pattern regex (validated on write) */
	namingPattern?: string;
	/** Raw governance text (from CLAUDE.md) */
	rawGovernance: string;
}

// ── Search ──────────────────────────────────────────────────

export interface SearchQuery {
	/** Text query (fuzzy matched against title + content + tags) */
	q?: string;
	/** Filter by note type */
	type?: string;
	/** Filter by tags (AND logic — all must match) */
	tags?: string[];
	/** Filter by zone (top-level folder) */
	zone?: string;
	/** Filter by project name */
	project?: string;
	/** Max results (default 20) */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
}

export interface SearchResult {
	path: string;
	title: string;
	type?: string;
	tags?: string[];
	project?: string;
	score: number;
	/** Matching content snippet */
	snippet?: string;
}

// ── Graph ───────────────────────────────────────────────────

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphNode {
	/** Note path (unique ID) */
	id: string;
	/** Display label (note title) */
	label: string;
	/** Note type from frontmatter */
	type?: string;
	/** Top-level zone folder */
	zone: string;
	/** Node size (based on total link count: outgoing + incoming) */
	size: number;
	/** Color (derived from zone) */
	color: string;
}

export interface GraphEdge {
	/** Source note path */
	source: string;
	/** Target note path */
	target: string;
	/** Edge label (link alias if any) */
	label?: string;
}

// ── Stats & Health ──────────────────────────────────────────

export interface VaultStats {
	totalNotes: number;
	notesByType: Record<string, number>;
	notesByZone: Record<string, number>;
	totalLinks: number;
	unresolvedLinks: number;
	orphanNotes: number;
	lastIndexed: string;
}

export interface VaultHealth {
	indexed: number;
	staleFiles: string[];
	orphanNotes: string[];
	unresolvedLinks: { source: string; raw: string }[];
	lastIndexed: string;
}

// ── Write Operations ────────────────────────────────────────

export interface CreateNoteRequest {
	/** Target zone (e.g., "projects/soul-hub/learnings") */
	zone: string;
	/** Filename (e.g., "2026-04-10-scheduler-race.md") */
	filename: string;
	/** Frontmatter fields */
	meta: VaultMeta;
	/** Markdown content body */
	content: string;
}

export interface UpdateNoteRequest {
	/** Updated frontmatter fields (merged with existing) */
	meta?: Partial<VaultMeta>;
	/** Updated content (replaces existing) */
	content?: string;
}

export interface WriteResult {
	success: true;
	path: string;
}

export interface WriteError {
	success: false;
	error: string;
	field?: string;
}

// ── Template ────────────────────────────────────────────────

export interface VaultTemplate {
	/** Template name (matches note type) */
	name: string;
	/** Raw template content with {{placeholders}} */
	raw: string;
	/** Required frontmatter fields extracted from template */
	requiredFields: string[];
	/** Section headings expected in the content */
	expectedSections: string[];
}

// ── Zone color mapping ──────────────────────────────────────

export const ZONE_COLORS: Record<string, string> = {
	projects: '#6366f1',   // indigo
	patterns: '#8b5cf6',   // violet
	research: '#06b6d4',   // cyan
	sessions: '#64748b',   // slate
	inbox: '#f59e0b',      // amber
	archive: '#6b7280',    // gray
};

export const TYPE_COLORS: Record<string, string> = {
	learning: '#10b981',   // emerald
	decision: '#f59e0b',   // amber
	debugging: '#ef4444',  // red
	pattern: '#8b5cf6',    // violet
	research: '#06b6d4',   // cyan
	output: '#3b82f6',     // blue
	daily: '#6b7280',      // gray
	snippet: '#ec4899',    // pink
	report: '#14b8a6',     // teal
	index: '#9ca3af',      // gray-400
	adr: '#f59e0b',        // amber (same as decision)
	analytics: '#06b6d4',  // cyan (same as research)
	'session-log': '#64748b', // slate
};

/** Default zone for notes without a recognized zone */
export const DEFAULT_ZONE = 'inbox';

/** Global required frontmatter fields (every note must have these) */
export const GLOBAL_REQUIRED_FIELDS = ['type', 'created', 'tags'];

/** Maximum note size in bytes (1MB) */
export const MAX_NOTE_SIZE = 1024 * 1024;

/** Folders to ignore when scanning */
export const IGNORED_FOLDERS = ['.vault', '.obsidian', '.git', 'node_modules', '.trash'];
