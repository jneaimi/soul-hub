/**
 * Soul Hub Agents — schema and types.
 *
 *   - `AgentSummarySchema` is the READ shape that `GET /api/agents` serves.
 *   - `AgentDraftSchema` is the WRITE shape validated on POST/PUT.
 *
 * Storage lanes per ADR-001:
 *   - Lane A: `~/.claude/agents/<id>.md`           — Claude Code native, frontmatter + body
 *   - Lane B: `~/.soul-hub/data/agents/<id>.yaml`  — Soul Hub native, full YAML
 *
 * Discriminated union on `backend`:
 *   - `claude-pty`     → Lane A, parallel-safe via existing PTY manager
 *   - `claude-cli-flag` → Lane A, single-call (`claude -p --agent <id>`)
 *   - `ai-sdk`         → Lane B, Vercel AI SDK 6 BYOK (Anthropic/OpenAI/OpenRouter/Google/Mistral)
 */

import { z } from 'zod';

// ─── primitives ────────────────────────────────────────────────────────────

export const BackendKind = z.enum(['claude-pty', 'claude-cli-flag', 'ai-sdk']);
export type BackendKind = z.infer<typeof BackendKind>;

export const Lane = z.enum(['A', 'B']);
export type Lane = z.infer<typeof Lane>;

export const Provenance = z.enum(['builtin', 'user-created', 'external']);
export type Provenance = z.infer<typeof Provenance>;

/** Health is computed at read time — not stored on disk. */
export const Health = z.enum(['ready', 'unhealthy', 'unknown']);
export type Health = z.infer<typeof Health>;

export const AiSdkProvider = z.enum([
	'anthropic',
	'openai',
	'openrouter',
	'google',
	'mistral',
]);
export type AiSdkProvider = z.infer<typeof AiSdkProvider>;

// ─── shared sub-schemas ────────────────────────────────────────────────────

const PermissionsSchema = z
	.object({
		vault_read: z.boolean().default(false),
		vault_write: z.boolean().default(false),
		web: z.boolean().default(false),
		shell: z.boolean().default(false),
	})
	.prefault({});

const BudgetSchema = z
	.object({
		max_usd: z.number().nonnegative().default(0.5),
		max_turns: z.number().int().positive().default(20),
		timeout_sec: z.number().int().positive().default(60),
	})
	.prefault({});

// Note: in Zod 4, `.default({})` on objects requires the full output shape.
// `.prefault({})` lets partial inputs flow to inner-field defaults — see the
// `feedback_zod_v4_prefault` memory.

// ─── read shape (what the API serves) ─────────────────────────────────────

export const AgentSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	backend: BackendKind,
	model: z.string().optional(),
	provider: AiSdkProvider.optional(),
	tools: z.array(z.string()),
	skills: z.array(z.string()),
	provenance: Provenance,
	lane: Lane,
	health: Health,
	health_reason: z.string().optional(),
	source_path: z.string(),
	system_prompt: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

// ─── write shape (used by POST/PUT, validated server-side) ────────────────

export const IdSlug = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9_-]*$/,
		'lowercase letters, digits, hyphens, or underscores; must start with a letter or digit',
	);

const ClaudePtyDraftSpec = z.object({
	backend: z.literal('claude-pty'),
	worktree_isolated: z.boolean().default(true),
	parallel_safe: z.boolean().default(true),
	mcp_preset: z.string().optional(),
});

const ClaudeCliFlagDraftSpec = z.object({
	backend: z.literal('claude-cli-flag'),
});

const AiSdkDraftSpec = z.object({
	backend: z.literal('ai-sdk'),
	provider: AiSdkProvider,
	model: z.string().min(1),
});

/** Write shape — what the wizard POSTs and what we validate server-side
 *  before persistence. The server computes `lane`, `source_path`, and
 *  `health` at read time, so they're not in the draft. */
export const AgentDraftSchema = z.object({
	id: IdSlug,
	name: z.string().min(1).default(''),
	description: z.string().default(''),
	model: z.string().optional(),
	tools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	permissions: PermissionsSchema,
	budget: BudgetSchema,
	system_prompt: z.string().default(''),
	provenance: Provenance.default('user-created'),
	spec: z.discriminatedUnion('backend', [
		ClaudePtyDraftSpec,
		ClaudeCliFlagDraftSpec,
		AiSdkDraftSpec,
	]),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

/** Map a backend kind to its storage lane per ADR-001. */
export function laneForBackend(backend: BackendKind): Lane {
	return backend === 'ai-sdk' ? 'B' : 'A';
}
