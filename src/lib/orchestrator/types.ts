/**
 * Orchestrator types.
 *
 * Per WhatsApp ADR-005: a Gemini Flash classifier sits above the vault-chat
 * fallthrough. It returns one of three actions:
 *
 *   - reply    — the orchestrator answered directly (use `reply` text)
 *   - dispatch — spawn an agent worker (`agent` + `task` populated)
 *   - clarify  — ambiguous; ask the user to rephrase (use `reply` text)
 *
 * `confidence` gates dispatch — see `decide.ts` for the second-guess logic.
 */

export type OrchestratorAction = 'reply' | 'dispatch' | 'clarify';

export interface OrchestratorDecision {
	action: OrchestratorAction;
	reply?: string;
	agent?: string;
	task?: string;
	confidence: number;
	reasoning?: string;
}

/** Outcome of `decide()`. The decision is what the orchestrator *would* do;
 *  the caller is responsible for executing it (sending reply, kicking off
 *  worker dispatch, etc.). */
export interface DecideResult {
	decision: OrchestratorDecision;
	/** When the LLM call or schema validation failed. The caller should fall
	 *  through to vault-chat rather than surfacing an error. */
	fellThrough: boolean;
	/** Human-readable note for logs — never shown to user. */
	note?: string;
}
