/** Unified channel presence layer — ADR-028 Phase 1.
 *
 *  Channel-agnostic state machine that wraps the slow operations on a chat
 *  turn (router LLM, orchestrator-v2, fallback dispatchVaultChat) with:
 *
 *    Layer A — native typing indicator, re-fired every 4s until stop()
 *    Layer B — a single in-place bubble: send placeholder → edit-to-final
 *
 *  Both channels (WhatsApp + Telegram) inject a channel-specific
 *  `PresenceAdapter` that exposes the three primitives — send, edit,
 *  typingTick — and the shared session machinery here handles bubble
 *  state, dedup, the typing loop, and the edit-failure fallback contract.
 *
 *  Why this exists: ADR-022's Layer B was implemented on the legacy
 *  `dispatchVaultChat` fallback in both channels but never migrated when
 *  orchestrator-v2 became the primary path. Every modern slow query
 *  (inbox tools, vault-chat via orchestrator, web-search) ran 30-90s with
 *  no bubble. This module is the single integration point that closes the
 *  gap for both channels in one move.
 *
 *  Failure contract: `finalize()` returns `false` when the edit didn't
 *  land (no bubble was sent, channel doesn't support edits, rate-limit).
 *  Callers MUST handle the false return by falling back to a fresh send
 *  of the same text — losing the bubble morph is acceptable, losing the
 *  final reply is not. */

import { placeholderTextForRoute, type PlaceholderOpts } from './placeholder.js';

export interface PresenceAdapter {
	/** Channel name — used in logs and intent_log. */
	channel: 'whatsapp' | 'telegram';
	/** Send a fresh text message. Returns the message id for later edit
	 *  if the channel can edit; returns no id (or an ok=false) when the
	 *  send itself fails. */
	send: (text: string) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
	/** Edit an existing message in place. Returns ok=false if the channel
	 *  doesn't support edits, the message has expired, or rate-limit hit. */
	edit: (messageId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
	/** Fire the channel's native typing indicator once. Idempotent;
	 *  swallow failures (presence is decorative). */
	typingTick: () => Promise<void>;
}

export interface PresenceSession {
	/** Send the route-specific placeholder bubble. No-op + returns the
	 *  existing id if already sent in this session. Returns `undefined`
	 *  when send fails (caller proceeds without a bubble; finalize will
	 *  fall back to a fresh send). */
	bubble: (route: string, opts?: PlaceholderOpts) => Promise<string | undefined>;
	/** Replace the bubble's text with the final reply. Returns `true`
	 *  when the edit landed; `false` when no bubble exists OR the edit
	 *  failed. Callers MUST handle false by sending `text` fresh. */
	finalize: (text: string) => Promise<boolean>;
	/** Same as `finalize` but semantically tagged as error path — logs
	 *  go to warn instead of debug. Behaviorally identical. */
	finalizeError: (text: string) => Promise<boolean>;
	/** Replace the bubble with a "moving on" message (e.g. when the
	 *  orchestrator returns a sub-action like image/dispatch that produces
	 *  its own follow-up). Same edit semantics as `finalize` but doesn't
	 *  imply "this turn is done". */
	morph: (text: string) => Promise<boolean>;
	/** Stop the typing loop. Idempotent. Call in `finally`. */
	stop: () => void;
	/** Lightweight introspection for tests / observability. */
	state: () => { bubbleId: string | undefined; lastText: string | undefined };
}

export interface PresenceOptions {
	/** Typing-tick interval. ADR-022 picked 4s based on Telegram's auto-
	 *  clearing behavior; same value works for WhatsApp. */
	typingIntervalMs?: number;
	/** Suppress the typing loop (rare — primarily for tests). */
	noTyping?: boolean;
}

const DEFAULT_TYPING_INTERVAL_MS = 4000;

export function startPresence(
	adapter: PresenceAdapter,
	opts: PresenceOptions = {},
): PresenceSession {
	const interval = opts.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

	let bubbleId: string | undefined;
	let lastText: string | undefined;
	let editsDisabled = false;
	let stopped = false;

	// Fire Layer A immediately + schedule re-fire.
	const fireTyping = () => {
		if (stopped) return;
		adapter.typingTick().catch(() => {/* decorative — swallow */});
	};
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	if (!opts.noTyping) {
		fireTyping();
		typingTimer = setInterval(fireTyping, interval);
	}

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = null;
		}
	};

	const bubble = async (
		route: string,
		o?: PlaceholderOpts,
	): Promise<string | undefined> => {
		if (bubbleId) return bubbleId; // already sent this turn
		const text = placeholderTextForRoute(route, o);
		try {
			const result = await adapter.send(text);
			if (result.ok && result.messageId) {
				bubbleId = result.messageId;
				lastText = text;
				return bubbleId;
			}
			console.warn(
				`[presence/${adapter.channel}] bubble send returned no messageId (ok=${result.ok} error=${result.error ?? 'none'}); proceeding without bubble`,
			);
		} catch (err) {
			console.warn(
				`[presence/${adapter.channel}] bubble send threw (${(err as Error).message}); proceeding without bubble`,
			);
		}
		return undefined;
	};

	const editTo = async (
		text: string,
		role: 'finalize' | 'finalizeError' | 'morph',
	): Promise<boolean> => {
		if (!bubbleId) return false;
		if (editsDisabled) return false;
		if (text === lastText) return true; // no-op dedup
		try {
			const result = await adapter.edit(bubbleId, text);
			if (result.ok) {
				lastText = text;
				return true;
			}
			// First edit failure disables further edits this session — the
			// channel either doesn't support edits or rate-limited us.
			// Callers fall back to fresh sends.
			editsDisabled = true;
			const level = role === 'finalizeError' ? 'warn' : 'debug';
			const logFn = level === 'warn' ? console.warn : console.log;
			logFn(
				`[presence/${adapter.channel}] edit failed during ${role} (${result.error ?? 'unknown'}); edits disabled for rest of session`,
			);
			return false;
		} catch (err) {
			editsDisabled = true;
			console.warn(
				`[presence/${adapter.channel}] edit threw during ${role} (${(err as Error).message}); edits disabled for rest of session`,
			);
			return false;
		}
	};

	return {
		bubble,
		finalize: (text) => editTo(text, 'finalize'),
		finalizeError: (text) => editTo(text, 'finalizeError'),
		morph: (text) => editTo(text, 'morph'),
		stop,
		state: () => ({ bubbleId, lastText }),
	};
}
