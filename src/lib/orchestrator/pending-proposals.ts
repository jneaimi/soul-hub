/**
 * Pending-proposal tracker — persists a one-step "I propose to do X" record
 * per conversation so the user's next message can confirm/redirect/cancel
 * without re-running the classifier.
 *
 * UX problem this solves (from 2026-05-06 chat test): the orchestrator
 * was auto-dispatching `researcher` on simple questions ("how's the
 * weather in UAE", "do we have research on agriculture"). The redesign
 * adds `propose-dispatch` as a non-final action — the orchestrator emits
 * a one-line proposal, this module stores it, and the inbound handler
 * intercepts the next user reply BEFORE running classification:
 *
 *   - "yes" / "go" / "do it"  → execute the pending proposal
 *   - "web" / "quick"          → swap the proposal for a `web-search` action
 *   - "no" / "cancel"          → drop the proposal, send acknowledgement
 *   - anything else            → drop the proposal, classify the new
 *                                message normally (the user moved on)
 *
 * Storage: same SQLite handle as `chat_history` (~/.soul-hub/data/inbox.db).
 * Schema is created lazily on first access. Stale rows pruned on each save.
 *
 * TTL: 10 minutes — long enough for a phone-side reply, short enough that
 * an old proposal can't fire surprise dispatches when the user comes back
 * an hour later with an unrelated message.
 */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';

const TTL_MS = 10 * 60 * 1000;

export interface PendingProposal {
	conversationKey: string;
	createdAt: number;
	expiresAt: number;
	agentId: string;
	task: string;
	/** Short label rendered into the proposal text (e.g. "Full research dive
	 *  on hydroponics"). Bounded ~80 chars by upstream classifier. */
	label: string;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS pending_proposals (
			conversation_key TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			agent_id TEXT NOT NULL,
			task TEXT NOT NULL,
			label TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_pending_proposals_expires
			ON pending_proposals(expires_at);
	`);
}

function db(): Database {
	const handle = getInboxDb();
	if (!schemaReady) {
		ensureSchema(handle);
		schemaReady = true;
	}
	return handle;
}

/** Stash a fresh proposal. Replaces any existing proposal on the same key
 *  — only the latest one is honoured, since the orchestrator can re-evaluate
 *  the user's intent on every turn. */
export function setPending(input: {
	conversationKey: string;
	agentId: string;
	task: string;
	label: string;
}): PendingProposal {
	const now = Date.now();
	const proposal: PendingProposal = {
		conversationKey: input.conversationKey,
		createdAt: now,
		expiresAt: now + TTL_MS,
		agentId: input.agentId,
		task: input.task,
		label: input.label,
	};

	const handle = db();
	pruneExpired(handle, now);

	handle
		.prepare(
			`INSERT OR REPLACE INTO pending_proposals
				(conversation_key, created_at, expires_at, agent_id, task, label)
				VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			proposal.conversationKey,
			proposal.createdAt,
			proposal.expiresAt,
			proposal.agentId,
			proposal.task,
			proposal.label,
		);

	return proposal;
}

/** Read the live proposal for a key. Returns undefined when nothing is
 *  pending or the row has expired (expired rows are dropped on read). */
export function getPending(conversationKey: string): PendingProposal | undefined {
	const handle = db();
	const now = Date.now();

	const row = handle
		.prepare(
			`SELECT conversation_key, created_at, expires_at, agent_id, task, label
				FROM pending_proposals
				WHERE conversation_key = ?`,
		)
		.get(conversationKey) as
		| {
				conversation_key: string;
				created_at: number;
				expires_at: number;
				agent_id: string;
				task: string;
				label: string;
		  }
		| undefined;

	if (!row) return undefined;

	if (row.expires_at < now) {
		clearPending(conversationKey);
		return undefined;
	}

	return {
		conversationKey: row.conversation_key,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		agentId: row.agent_id,
		task: row.task,
		label: row.label,
	};
}

/** Drop a proposal — used when user confirmed (post-dispatch) or declined. */
export function clearPending(conversationKey: string): void {
	db().prepare(`DELETE FROM pending_proposals WHERE conversation_key = ?`).run(conversationKey);
}

function pruneExpired(handle: Database, now: number): void {
	handle.prepare(`DELETE FROM pending_proposals WHERE expires_at < ?`).run(now);
}

/** Classify a user reply against a live proposal. Pure string analysis;
 *  no LLM call. Tight matching on common confirm/decline tokens — anything
 *  ambiguous returns 'unrelated' so we drop the proposal and re-classify
 *  the new message normally rather than guessing.
 *
 *  Confirm tokens are intentionally narrow — "ok" alone could be a
 *  conversational ack; users explicitly typing "yes" / "go" / "do it" /
 *  "ship it" / "go ahead" / "👍" want to confirm.
 *
 *  "web" / "quick" / "search" → user wants a quick web lookup instead
 *  of the heavy agent; the inbound handler converts the proposal to a
 *  `web-search` action and clears the proposal.
 */
export type ProposalReplyKind = 'confirm' | 'decline' | 'switch-to-web' | 'unrelated';

export function classifyProposalReply(message: string): ProposalReplyKind {
	const m = message.trim().toLowerCase();
	if (m.length === 0) return 'unrelated';

	// Confirm — short, explicit affirmations only.
	if (/^(yes|y|yep|yeah|sure|ok\s*(go|do)|go|go ahead|do it|ship it|run it|start|fire|🚀|👍|✅)\b\.?$/i.test(m)) {
		return 'confirm';
	}

	// Switch to web search.
	if (/^(web|quick|search|just search|web search|google it)\b\.?$/i.test(m)) {
		return 'switch-to-web';
	}

	// Decline.
	if (/^(no|nope|cancel|skip|nah|forget it|stop|drop it|❌|🛑)\b\.?$/i.test(m)) {
		return 'decline';
	}

	return 'unrelated';
}

/** Render the proposal text the orchestrator sends to the user. Templated
 *  in code (not LLM-generated) so prompt-injection in the user message
 *  can't change the action that fires on "yes". The label/agentId comes
 *  from the structured classifier output and is bound to the row. */
export function formatProposal(proposal: PendingProposal): string {
	return [
		`Looks like you want *${proposal.label}*.`,
		``,
		`Reply *yes* to run *${proposal.agentId}* (heavy — minutes), *web* for a quick web summary instead, or *no* to drop it.`,
	].join('\n');
}
