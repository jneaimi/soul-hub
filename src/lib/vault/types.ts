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
	source_agent?: string;
	source_context?: string;
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
	/** Allowed `status:` values for `type: decision` notes (canonical set per
	 *  zone). Empty = no restriction. Sourced from CLAUDE.md `## Allowed
	 *  Statuses` section. */
	allowedStatuses: string[];
	/** Allowed relationship-field NAMES on decision notes (e.g. supersedes,
	 *  blocks, blocked_by, relates_to, extends, superseded_by). Values for
	 *  these fields must be wikilink format `[[slug]]` (or list of). Empty =
	 *  no restriction. Sourced from CLAUDE.md `## Allowed Relationship Fields`. */
	allowedRelationshipFields: string[];
	/** Raw governance text (from CLAUDE.md) */
	rawGovernance: string;
}

// ── Search ──────────────────────────────────────────────────

export interface SearchQuery {
	/** Text query (fuzzy matched against title + content + tags) */
	q?: string;
	/** Filter by note type (single or multiple, OR logic) */
	type?: string | string[];
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
	/** Note tags from frontmatter */
	tags?: string[];
	/** Node size (based on total link count: outgoing + incoming) */
	size: number;
	/** Color (derived from zone) */
	color: string;
	/** Raw degree count (links + backlinks + tag connections) for ranking */
	degree?: number;
	/** File modification time (ms since epoch) — for date range filtering */
	mtime?: number;
	/** Frontmatter `created` date string (YYYY-MM-DD) — semantic newness */
	created?: string;
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
	/** ADR-047 — link-validator warnings (non-fatal). Empty array elided on the
	 *  wire by the API route when there are no warnings. */
	warnings?: LinkIssue[];
}

export interface WriteError {
	success: false;
	error: string;
	field?: string;
	/** ADR-047 — populated when refusal is link-validation driven. The `error`
	 *  string carries the first issue's human-readable message; this array
	 *  carries every error for batch correction by the agent. */
	linkErrors?: LinkIssue[];
}

/** ADR-047 — shape of a single wikilink validation issue. Re-exported from
 *  `link-validator.ts` so API callers don't need to import the validator. */
export interface LinkIssue {
	rule: 'auto-memory-wikilink' | 'bare-project-slug' | 'unresolved-target';
	link: string;
	suggestion: string;
}

export interface WriteLogEntry {
	timestamp: string;
	action: 'create' | 'update' | 'archive' | 'move' | 'delete' | 'create-asset';
	path: string;
	previousPath?: string;
	agent?: string;
	context?: string;
	zone: string;
	type?: string;
	success: boolean;
	error?: string;
}

/** Slice 0 — binary asset writes. Mirrors `CreateNoteRequest` discipline
 *  but for non-markdown files (images, voice, video, documents). Captures
 *  land in `inbox/assets/<YYYY-MM-DD>-<slug>.<ext>` per the brain
 *  frontmatter contract. Notes reference assets via `attachments[].path`. */
export interface WriteAssetRequest {
	/** Target zone (e.g., "inbox/assets"). */
	zone: string;
	/** Filename including extension (e.g., "2026-05-03-voice-note.ogg"). */
	filename: string;
	/** Raw bytes. */
	buffer: Buffer;
	/** MIME type (e.g., "audio/ogg", "image/jpeg"). Stored in the write
	 *  log for audit; not enforced beyond size + zone checks. */
	mimetype: string;
	/** Agent name for rate limiting + audit (e.g., "whatsapp-brain"). */
	agent?: string;
	/** Optional source context (chat JID, message ID) for traceability. */
	context?: string;
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
	inbox: '#f59e0b',        // amber
	projects: '#6366f1',     // indigo
	knowledge: '#06b6d4',    // cyan
	content: '#8b5cf6',      // violet
	operations: '#64748b',   // slate
	archive: '#6b7280',      // gray
};

export const TYPE_COLORS: Record<string, string> = {
	// Knowledge types
	learning: '#10b981',     // emerald
	decision: '#f59e0b',     // amber
	debugging: '#ef4444',    // red
	pattern: '#8b5cf6',      // violet
	research: '#06b6d4',     // cyan
	snippet: '#ec4899',      // pink
	report: '#14b8a6',       // teal
	analysis: '#06b6d4',     // cyan
	review: '#14b8a6',       // teal
	recipe: '#f97316',       // orange
	evaluation: '#06b6d4',   // cyan
	'data-pack': '#06b6d4',  // cyan
	reference: '#9ca3af',    // gray-400
	guide: '#9ca3af',        // gray-400
	wiki: '#9ca3af',         // gray-400
	// Content types
	draft: '#a78bfa',        // violet-400
	'social-draft': '#a78bfa',
	'social-post': '#8b5cf6',
	'article-draft': '#a78bfa',
	'video-script': '#c084fc',
	'video-script-draft': '#c084fc',
	'content-menu': '#8b5cf6',
	'content-prep': '#8b5cf6',
	ideas: '#d946ef',        // fuchsia
	'daily-quote': '#d946ef',
	'media-asset': '#8b5cf6',
	'insight-draft': '#a78bfa',
	'miner-report': '#14b8a6',
	'signal-report': '#14b8a6',
	'strategist-prep': '#14b8a6',
	'action-list': '#0d9488',       // teal-600 — Strategist outputs
	'weekly-review': '#0d9488',
	// Project types
	project: '#6366f1',      // indigo
	output: '#3b82f6',       // blue
	index: '#9ca3af',        // gray-400
	task: '#3b82f6',         // blue
	design: '#6366f1',       // indigo
	requirements: '#6366f1', // indigo
	// Operations types
	'agent-profile': '#64748b',
	config: '#64748b',
	'session-log': '#64748b',
	playbook: '#64748b',
	'system-config': '#64748b',
	identity: '#64748b',
	boundaries: '#64748b',
	// Legacy (migration compat)
	daily: '#6b7280',
	adr: '#f59e0b',
	analytics: '#06b6d4',
};

/**
 * Tailwind chip classes per note type — used by sidebar/search/list chips.
 * Format: `bg-{color}-500/20 text-{color}-400` for visual distinction
 * (darker shade behind a lighter foreground). Single source of truth so
 * Sidebar/Search/List don't drift out of sync.
 *
 * For inline-style chips (e.g. table cells in `VaultList`), use `TYPE_COLORS`
 * directly with `style="background-color: {hex}26; color: {hex}"`.
 */
export const TYPE_CHIP_CLASSES: Record<string, string> = {
	// Knowledge
	learning: 'bg-emerald-500/20 text-emerald-400',
	decision: 'bg-amber-500/20 text-amber-400',
	debugging: 'bg-red-500/20 text-red-400',
	pattern: 'bg-violet-500/20 text-violet-400',
	research: 'bg-cyan-500/20 text-cyan-400',
	snippet: 'bg-pink-500/20 text-pink-400',
	report: 'bg-teal-500/20 text-teal-400',
	analysis: 'bg-cyan-500/20 text-cyan-400',
	review: 'bg-teal-500/20 text-teal-400',
	recipe: 'bg-orange-500/20 text-orange-400',
	reference: 'bg-gray-500/20 text-gray-400',
	guide: 'bg-gray-500/20 text-gray-400',
	wiki: 'bg-gray-500/20 text-gray-400',
	// Content
	draft: 'bg-violet-500/20 text-violet-300',
	'social-draft': 'bg-violet-500/20 text-violet-300',
	'social-post': 'bg-violet-500/20 text-violet-400',
	'article-draft': 'bg-violet-500/20 text-violet-300',
	'video-script': 'bg-purple-500/20 text-purple-400',
	'content-menu': 'bg-violet-500/20 text-violet-400',
	ideas: 'bg-fuchsia-500/20 text-fuchsia-400',
	'daily-quote': 'bg-fuchsia-500/20 text-fuchsia-400',
	'media-asset': 'bg-violet-500/20 text-violet-400',
	'miner-report': 'bg-teal-500/20 text-teal-400',
	'signal-report': 'bg-teal-500/20 text-teal-400',
	'strategist-prep': 'bg-teal-500/20 text-teal-300',
	'action-list': 'bg-teal-600/20 text-teal-300',
	'weekly-review': 'bg-teal-600/20 text-teal-300',
	'data-pack': 'bg-cyan-500/20 text-cyan-400',
	'content-prep': 'bg-violet-500/20 text-violet-300',
	// Project
	project: 'bg-indigo-500/20 text-indigo-400',
	output: 'bg-blue-500/20 text-blue-400',
	index: 'bg-gray-500/20 text-gray-400',
	task: 'bg-blue-500/20 text-blue-400',
	design: 'bg-indigo-500/20 text-indigo-400',
	// Operations
	'agent-profile': 'bg-slate-500/20 text-slate-400',
	config: 'bg-slate-500/20 text-slate-400',
	'session-log': 'bg-slate-500/20 text-slate-400',
	playbook: 'bg-slate-500/20 text-slate-400',
	// Legacy / migration compat
	daily: 'bg-gray-500/20 text-gray-400',
	adr: 'bg-amber-500/20 text-amber-400',
	analytics: 'bg-cyan-500/20 text-cyan-400',
};

/** Fallback chip class for an unrecognized note type. */
export const DEFAULT_TYPE_CHIP_CLASS = 'bg-hub-card text-hub-dim';

/** Default zone for notes without a recognized zone */
export const DEFAULT_ZONE = 'inbox';

/** Global required frontmatter fields (every note must have these) */
export const GLOBAL_REQUIRED_FIELDS = ['type', 'created', 'tags'];

/** Maximum note size in bytes (1MB) */
export const MAX_NOTE_SIZE = 1024 * 1024;

/** Maximum asset size in bytes (16MB). Aligned with the worker `_inbound`
 *  `mediaBase64?` cap so anything the worker can ship up the main app can
 *  also persist. Base64 inflates by ~33%, so 16MB raw ≈ 22MB encoded — the
 *  worker side caps the *encoded* string at 16MB to stay under SvelteKit's
 *  default request body limit. Keep in sync. */
export const MAX_ASSET_SIZE = 16 * 1024 * 1024;

/** Folders to ignore when scanning */
export const IGNORED_FOLDERS = ['.vault', '.obsidian', '.git', 'node_modules', '.trash'];
