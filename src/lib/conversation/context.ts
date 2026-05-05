/**
 * Unified conversation context — single read surface across the two SQLite
 * stores that hold WhatsApp conversation state.
 *
 *   - `chat_history` lives in `inbox.db` (owned by vault-chat's history.ts).
 *   - `agent_runs` lives in `whatsapp/heartbeat.db` (owned by agents/runs.ts).
 *
 * The orchestrator and any future per-conversation reasoner reads from here
 * instead of touching either store directly. Two narrow queries, no join,
 * no schema migration.
 *
 * Conversation key convention is the one already in `_inbound`:
 *   DM    → `senderNumber` (E.164)
 *   Group → `chatJid`
 *
 * The optional `jid` is the full WhatsApp JID (e.g. `971500000099@s.whatsapp.net`)
 * used to look up `agent_runs`. Pass it when you have it; without it, the
 * recent-dispatches slice comes back empty (history alone is still useful).
 */

import { loadHistory } from '$lib/vault-chat/history.js';
import { listAgentRunsByJid } from '$lib/agents/runs.js';
import type { ChatMessage } from '$lib/llm/types.js';

export interface AgentRunSummary {
	agentId: string;
	status: string;
	startedAt: number;
	excerpt: string;
}

export interface ConversationContext {
	history: ChatMessage[];
	recentDispatches: AgentRunSummary[];
}

export interface ContextOptions {
	jid?: string;
	recentLimit?: number;
}

const EXCERPT_MAX = 240;
const TURN_PREVIEW_MAX = 280;
const BRIEF_HISTORY_TURNS = 4;
const BRIEF_DISPATCHES = 2;

export function getConversationContext(
	conversationKey: string,
	opts: ContextOptions = {},
): ConversationContext {
	const history = conversationKey ? loadHistory(conversationKey) : [];
	const recentDispatches: AgentRunSummary[] = opts.jid
		? listAgentRunsByJid(opts.jid, { limit: opts.recentLimit ?? 3, mode: 'production' }).map(
				(r) => ({
					agentId: r.agentId,
					status: r.status,
					startedAt: r.startedAt,
					excerpt: (r.resultExcerpt ?? '').slice(0, EXCERPT_MAX),
				}),
			)
		: [];
	return { history, recentDispatches };
}

/** Build a short brief that the orchestrator inlines into a dispatched
 *  agent's task. Bounded to ~600 chars so it doesn't blow CLI prompt
 *  budgets — agents like `scribe`/`weaver` produce content from a spec, not
 *  a chat continuation, and a 16-turn dump confuses them. The brief carries
 *  the prior topic + the gist of the most recent agent answers, nothing more. */
export function buildAgentContextBrief(ctx: ConversationContext): string {
	const parts: string[] = [];
	if (ctx.history.length > 0) {
		const recent = ctx.history.slice(-BRIEF_HISTORY_TURNS);
		const lines = recent.map(
			(t) => `**${t.role}:** ${t.content.slice(0, TURN_PREVIEW_MAX).replace(/\s+/g, ' ').trim()}`,
		);
		parts.push('## Conversation context\n' + lines.join('\n\n'));
	}
	if (ctx.recentDispatches.length > 0) {
		const lines = ctx.recentDispatches
			.slice(0, BRIEF_DISPATCHES)
			.map((d) => `- ${d.agentId} (${d.status}): ${d.excerpt.slice(0, 160)}`);
		parts.push('## Recent agent runs\n' + lines.join('\n'));
	}
	return parts.join('\n\n---\n\n');
}

// ANSI control sequences (CSI, OSC, SS3, DCS) + raw control chars + the
// box / block / shade drawing chars Claude Code's TUI uses for its banner.
// PTY-backed lanes (claude-pty) leak all of this into the captured output
// buffer; without stripping, summaries from cancelled-mid-init runs are
// unreadable for both humans AND the orchestrator's next decide() call.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1bP[\s\S]*?\x1b\\)|(?:\x1b[NOPX^_])|[\x00-\x08\x0B-\x1F\x7F]/g;
const BOX_DRAW_RE = /[─-▟■-◿]+/g;

function stripTerminalNoise(s: string): string {
	return s.replace(ANSI_RE, '').replace(BOX_DRAW_RE, '').replace(/\s+/g, ' ').trim();
}

const MIN_ALPHA_WORDS_FOR_USEFUL_LINE = 3;
const WORD_RE = /[A-Za-z]{3,}/g;

function alphaWordCount(s: string): number {
	const m = s.match(WORD_RE);
	return m ? m.length : 0;
}

// The Claude Code TUI startup banner survives ANSI/box stripping because
// the model names + version strings are all alpha-word-heavy. After the
// box-draw chars between them are stripped, you get one long line like
// "ClaudeCodev2.1.128 Sonnet4.6·ClaudeMax". Targeted regex catches it
// without false-positive risk (no real sentence concatenates a model
// version + model name like this).
const CC_BANNER_RE = /Claude\s*Code\s*v\d|ClaudeCode\s*v\d|Claude\s*Max|·\s*Claude\s*Max/i;

function looksLikeClaudeCodeBanner(s: string): boolean {
	return CC_BANNER_RE.test(s);
}

/** One-line writeback to `chat_history` after an agent finishes, so the next
 *  conversational turn (in either the orchestrator or vault-chat) sees the
 *  gist of what the agent answered. Raw output stays in `agent_runs.output`
 *  for full retrieval; this is just an anchor for anaphoric resolution. */
export function summarizeAgentResultForHistory(
	agentId: string,
	output: string | undefined,
	error: string | undefined,
	status: string,
): string {
	const raw = output && output.trim() ? output : error && error.trim() ? error : '';
	// Walk the lines and pick the first one that survives ANSI/box stripping
	// with enough alphanumeric content to be a real sentence. Cancelled PTY
	// runs can have many leading lines that are pure control codes / banners.
	let cleaned = '';
	for (const line of raw.split('\n')) {
		const c = stripTerminalNoise(line);
		if (alphaWordCount(c) >= MIN_ALPHA_WORDS_FOR_USEFUL_LINE) {
			cleaned = c.slice(0, EXCERPT_MAX);
			break;
		}
	}
	const tag = status === 'success' ? '' : ` [${status}]`;
	return cleaned ? `[${agentId}${tag}] ${cleaned}` : `[${agentId}${tag}] (no useful output)`;
}

// Patterns the chat-trailer parser splits on. The Phase 1 output-shape spec
// asks chat-dispatchable agents to end their stdout with a literal
// `---CHAT---` marker followed by a short summary. Until Phase 3 ships,
// only some agents emit it; we fall back to whole-output cleaning for the
// rest. Marker check is exact-line + case-sensitive to keep false-positive
// rate near zero (vault notes occasionally contain `---` separators).
const CHAT_TRAILER_RE = /^[ \t]*---CHAT---[ \t]*$/m;

// Heuristic vault-path detection. Three real shapes observed in agent
// outputs: explicit "Saved to: <path>", a bare path like
// "~/vault/<…>.md" or "vault/<…>.md", and an Obsidian wikilink at the end.
// Stops at the first match — agents only report one final landing place.
const VAULT_LABEL_RE = /(?:Saved to|Vault path|Saved|Wrote to)[:\s]+([~]?\/?(?:Users\/[^\s]+\/vault\/|vault\/)[^\s`'")]+\.md)/i;
const VAULT_RAW_PATH_RE = /([~]?\/?(?:Users\/[^\s]+\/vault\/|vault\/)[^\s`'")]+\.md)/;
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/;

/** Best-effort vault-path extraction from agent output. Returns the relative
 *  path under `~/vault/` so the caller can render a `https://soul-hub…/vault/notes/<path>`
 *  URL. Returns null when nothing plausible is found.
 *
 *  Phase 1.5a uses heuristics; Phase 1.5b will rely on the structured
 *  trailer for guaranteed extraction. */
export function extractVaultPath(output: string | undefined): string | null {
	if (!output) return null;
	const labeled = output.match(VAULT_LABEL_RE);
	const raw = labeled ? labeled[1] : output.match(VAULT_RAW_PATH_RE)?.[1];
	if (raw) {
		// Normalise to vault-relative path (strip ~/, /Users/<user>/vault/, vault/).
		return raw
			.replace(/^~\//, '')
			.replace(/^\/Users\/[^/]+\/vault\//, '')
			.replace(/^vault\//, '')
			.replace(/^\/+/, '');
	}
	const wiki = output.match(WIKILINK_RE);
	if (wiki) {
		const target = wiki[1].trim();
		// Only accept wikilinks that look like a path (contain "/" or end in
		// .md). Display aliases for entities ([[OpenAI]]) shouldn't get linked.
		if (target.includes('/') || /\.md$/i.test(target)) {
			return target.replace(/\.md$/i, '') + '.md';
		}
	}
	return null;
}

/** Multi-line cleaner for chat replies. Strips ANSI/box noise per line,
 *  drops banner-y lines (require ≥3 alphabetic words to keep), collapses
 *  internal whitespace, caps total length. Used in the WhatsApp settle
 *  path so the user sees prose instead of a TUI dump.
 *
 *  Trailer-aware: if the agent emitted a `---CHAT---` marker, only the
 *  body below the marker is returned (the long-form report stays in the
 *  vault note as planned in Phase 1.5b). When no marker is present we
 *  clean the whole output. */
export function cleanAgentOutputForChat(output: string | undefined, maxLen = 3500): string {
	if (!output || !output.trim()) return '';
	const trailerMatch = output.match(CHAT_TRAILER_RE);
	const source = trailerMatch
		? output.slice((trailerMatch.index ?? 0) + trailerMatch[0].length)
		: output;

	const kept: string[] = [];
	for (const line of source.split('\n')) {
		const c = line.replace(ANSI_RE, '').replace(BOX_DRAW_RE, '').trimEnd();
		// Drop pure-whitespace and banner-y leftovers, but keep blank-line
		// separators between paragraphs (max one blank in a row).
		if (!c.trim()) {
			if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
			continue;
		}
		if (alphaWordCount(c) < MIN_ALPHA_WORDS_FOR_USEFUL_LINE) continue;
		if (looksLikeClaudeCodeBanner(c)) continue;
		kept.push(c.replace(/\s+/g, ' ').trim());
	}
	// Strip a possible trailing blank.
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

	const joined = kept.join('\n');
	if (joined.length <= maxLen) return joined;
	return joined.slice(0, maxLen - 1).trimEnd() + '…';
}
