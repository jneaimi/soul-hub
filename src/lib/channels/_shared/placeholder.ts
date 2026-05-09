/** Route → placeholder text mapping. Per ADR-022 Layer B.
 *
 *  v0: route name + a couple of context flags drive the text. ADR-023 will
 *  add a `placeholder_text` column to `intent_patterns` so pattern-routed
 *  dispatches get topic-specific text ("Pulling up your Wed draft now…")
 *  instead of the generic route default. Until then the dispatcher passes
 *  `patternText` through if it has one; we use it verbatim. */

export interface PlaceholderOpts {
	/** When the route is `vault-chat` and the user message matched the
	 *  focus-query regex (per `vault-chat/selector.ts:isFocusQuery`),
	 *  swap the generic "looking through your vault" text for the more
	 *  precise "pulling up the latest one". */
	isFocusQuery?: boolean;
	/** When the user attached an image / video / document, signal that
	 *  the bubble is acknowledging media specifically. */
	hasMedia?: boolean;
	/** Agent dispatch — surfaces the agent name in the bubble. */
	agentId?: string;
	/** ADR-023 hook — when a pattern fires deterministically, the
	 *  pattern's own placeholder text wins over the route default. */
	patternText?: string;
}

const ROUTE_DEFAULTS: Record<string, string> = {
	'vault-chat': '🟡 Looking through your vault…',
	'brain-find': '🟡 Searching for matches…',
	'brain-recent': '🟡 Fetching recent notes…',
	'brain-save': '🟡 Saving to vault…',
	img: '🟡 Generating the image…',
};

const VAULT_CHAT_FOCUS = '🟡 Pulling up the latest one…';
const VAULT_CHAT_MULTIMODAL = '🟡 Reading what you sent…';
const FALLBACK = '🟡 Working on it…';

export function placeholderTextForRoute(
	route: string,
	opts: PlaceholderOpts = {},
): string {
	if (opts.patternText) return opts.patternText;

	if (opts.agentId) {
		return `🟡 Running *${opts.agentId}*…`;
	}

	if (route === 'vault-chat') {
		if (opts.hasMedia) return VAULT_CHAT_MULTIMODAL;
		if (opts.isFocusQuery) return VAULT_CHAT_FOCUS;
	}

	return ROUTE_DEFAULTS[route] ?? FALLBACK;
}

/** Detect "focus" queries — mirrors `vault-chat/selector.ts:isFocusQuery`
 *  but lives here so the placeholder helper has no dependency on the
 *  selector module (avoids circular imports during early routing).
 *  Pattern: "the/my/this/that" + "latest/newest/most recent/last" +
 *  singular content noun. */
export function isFocusQuery(message: string): boolean {
	const lower = message.toLowerCase();
	return /\b(?:the|my|that|this)\s+(?:latest|newest|most\s+recent|last)\s+(?:draft|post|note|decision|writeup|writup|adr|entry|capture|save|article|reference|learning|debug|debugging|research|recipe|pattern|snippet)\b/.test(
		lower,
	);
}
