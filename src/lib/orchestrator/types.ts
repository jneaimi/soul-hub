/**
 * Orchestrator types.
 *
 * Per WhatsApp ADR-005 + ADR-006 (2026-05-06 redesign): a Gemini Flash
 * classifier sits above the vault-chat fallthrough. It returns one of
 * SEVEN actions, with a hard bias toward conversation over execution.
 *
 *   - reply           — answer directly with training-data knowledge or chat
 *   - web-search      — quick Gemini-grounded Google Search (current facts,
 *                       weather, news, single-fact lookups)
 *   - vault-search    — defer to vault-chat for existing-knowledge lookups
 *                       ("do we have…", "what did we save…")
 *   - generate-image  — text-to-image via the existing `/img` route
 *                       (Gemini Nano Banana). For natural-language image
 *                       requests like "make me a picture of X". Cheap path.
 *                       The heavy media-generator agent (carousel/video/
 *                       voice/Arabic-overlay) lands as Phase 2 via
 *                       `propose-dispatch`.
 *   - propose-dispatch — proposes a heavy agent dispatch and waits for
 *                       confirmation (the new default for any topic-shaped
 *                       message that doesn't carry an explicit command verb)
 *   - dispatch        — fire the specialist agent NOW. Reserved for messages
 *                       with unambiguous command verbs ("research X for me",
 *                       "draft Y", "review Z code") OR for the
 *                       confirm-pending-proposal path.
 *   - clarify         — genuinely ambiguous; ask the user to rephrase.
 *
 * The redesign was driven by a 2026-05-06 chat test where the previous
 * 3-action model auto-dispatched `researcher` on "how is the weather in
 * the UAE" (should have been web-search) and "do we have any research on
 * agriculture" (should have been vault-search). Adding `web-search` and
 * `vault-search` as first-class actions plus the propose-confirm pattern
 * brings the orchestrator in line with how Claude Code / Cursor / Codex
 * "plan mode" handles intent-uncertainty (review before execute).
 *
 * `confidence` gates the high-cost actions — see `decide.ts`.
 */

export type OrchestratorAction =
	| 'reply'
	| 'web-search'
	| 'vault-search'
	| 'generate-image'
	| 'propose-dispatch'
	| 'dispatch'
	| 'clarify';

export interface OrchestratorDecision {
	action: OrchestratorAction;
	/** For `reply` and `clarify`: the text the user will see. For
	 *  `propose-dispatch`: optional one-line preface (the proposal text
	 *  itself is rendered deterministically by the inbound handler). */
	reply?: string;
	/** For `dispatch` and `propose-dispatch`: which specialist. */
	agent?: string;
	/** For `dispatch` and `propose-dispatch`: the self-contained instruction
	 *  the agent will execute. */
	task?: string;
	/** For `propose-dispatch`: a short label describing what the agent will
	 *  do, rendered into the proposal text. ~80 chars. */
	proposalLabel?: string;
	/** For `web-search`: the grounded query string. Often identical to the
	 *  user message but may be tightened (e.g. add location context). */
	webQuery?: string;
	/** For `generate-image`: the cleaned image prompt (description of the
	 *  image to produce, with the leading verb stripped — e.g. user says
	 *  "generate an image of a person fishing in the UAE", model returns
	 *  "a person fishing in the UAE"). Falls back to userMessage when the
	 *  model omits it. */
	imagePrompt?: string;
	confidence: number;
	reasoning?: string;
}

export interface DecideResult {
	decision: OrchestratorDecision;
	/** When the LLM call or schema validation failed. The caller should fall
	 *  through to vault-chat rather than surfacing an error. */
	fellThrough: boolean;
	/** Human-readable note for logs — never shown to user. */
	note?: string;
}
