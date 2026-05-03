/** Public entry point: `dispatchVaultChat(message)` — runs the lexical
 *  retrieval pipeline (selector → tools → format) and then hands the
 *  augmented ChatRequest to `dispatchRoute('vault-chat', …)` so the
 *  routes layer's failover/circuit-breaker still kicks in for the final
 *  LLM call.
 *
 *  Per ADR-004: replaces the embeddings-RAG path. Fast (~30 ms retrieval +
 *  one chat LLM call), free (no embedding API), deterministic, fresh. */

import { dispatchRoute } from '../routes/index.js';
import type { DispatchResult } from '../routes/types.js';
import { selectTools } from './selector.js';
import { retrieve } from './retrieval.js';
import { buildSystemPrompt, formatContextBlock } from './format.js';
import { loadHistory, saveTurn, pruneStaleHistory, buildRetrievalInput } from './history.js';

const ROUTE_NAME = 'vault-chat';
const ANSWER_MAX_TOKENS = 800;

export interface VaultChatTrace {
	selectorSource: 'gemini' | 'heuristic';
	selectorReason?: string;
	toolsRun: { name: string; args: Record<string, unknown> }[];
	notesSurfaced: number;
	notesUsed: number;
	contextBytes: number;
	retrievalMs: number;
	historyTurns: number;
}

export interface VaultChatResult extends DispatchResult {
	trace: VaultChatTrace;
}

/** Run a vault-chat turn end-to-end.
 *
 *  When `conversationKey` is supplied (the WhatsApp dispatcher passes
 *  `senderNumber` for DMs and `chatJid` for groups), prior turns are loaded
 *  and threaded into the LLM call so the bot remembers context. Retrieval
 *  also widens its query to include the last 2 user turns, which is what
 *  lets follow-ups like "tell me more about that" resolve.
 *
 *  Without a key (e.g. the `/api/vault-chat/test` debug endpoint when no
 *  key is provided) the call is stateless — same as the pre-history
 *  behaviour. */
export async function dispatchVaultChat(
	userMessage: string,
	conversationKey?: string,
): Promise<VaultChatResult> {
	const retrievalStart = Date.now();

	const history = conversationKey ? loadHistory(conversationKey) : [];
	const retrievalInput = buildRetrievalInput(history, userMessage);

	const selection = await selectTools(retrievalInput);
	const outcome = retrieve(selection.tools);
	const contextBlock = formatContextBlock(outcome.notes);
	const systemPrompt = buildSystemPrompt(contextBlock);
	const retrievalMs = Date.now() - retrievalStart;

	const trace: VaultChatTrace = {
		selectorSource: selection.source,
		selectorReason: selection.reason,
		toolsRun: outcome.toolsRun.map((t) => ({ name: t.name, args: t.args })),
		notesSurfaced: outcome.totalSurfaced,
		notesUsed: outcome.notes.length,
		contextBytes: contextBlock.length,
		retrievalMs,
		historyTurns: history.length,
	};

	const result = await dispatchRoute(ROUTE_NAME, {
		system: systemPrompt,
		messages: [...history, { role: 'user', content: userMessage }],
		maxOutputTokens: ANSWER_MAX_TOKENS,
	});

	// Persist the round-trip after a successful answer so a failed call
	// doesn't leave half a turn in the log. Prune stale rows on the same
	// path to keep the table tidy without a separate cron.
	if (conversationKey && result.text) {
		const now = Date.now();
		saveTurn(conversationKey, 'user', userMessage, now);
		saveTurn(conversationKey, 'assistant', result.text, now + 1);
		pruneStaleHistory(now);
	}

	return { ...result, trace };
}
