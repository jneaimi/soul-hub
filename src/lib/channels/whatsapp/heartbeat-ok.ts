/** HEARTBEAT_OK token contract — replaces the v1 condition language.
 *
 *  The agent decides if anything's worth surfacing. If the reply is
 *  effectively just the OK acknowledgment (token at start or end + the
 *  remaining content is below `ackMaxChars`), we suppress delivery and
 *  log the run as `ack`.
 *
 *  Token in the middle of a message is left alone — it's almost certainly
 *  the model quoting itself rather than acking. */

export const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';

export interface StripResult {
	/** True when the run should be treated as an OK ack — no delivery. */
	shouldSkip: boolean;
	/** Text minus the token; what gets delivered when `shouldSkip` is false. */
	cleanText: string;
}

export interface StripOptions {
	/** Max chars of non-token content allowed for ack-only suppression. */
	ackMaxChars: number;
}

/** Detect and strip the HEARTBEAT_OK token. */
export function stripHeartbeatToken(rawInput: string | undefined, opts: StripOptions): StripResult {
	const text = (rawInput ?? '').trim();
	if (!text) {
		// Empty model output is treated as an ack — nothing to deliver anyway.
		return { shouldSkip: true, cleanText: '' };
	}

	const max = Math.max(0, Math.floor(opts.ackMaxChars));

	// Strip a leading token (with optional trailing punctuation/space).
	const leadingRe = new RegExp(`^${HEARTBEAT_OK_TOKEN}\\b[\\s.:,!\\-]*`);
	const trailingRe = new RegExp(`[\\s.:,!\\-]*\\b${HEARTBEAT_OK_TOKEN}$`);

	let stripped = text;
	let foundLeading = false;
	let foundTrailing = false;

	if (leadingRe.test(stripped)) {
		stripped = stripped.replace(leadingRe, '').trim();
		foundLeading = true;
	}
	if (trailingRe.test(stripped)) {
		stripped = stripped.replace(trailingRe, '').trim();
		foundTrailing = true;
	}

	if (!foundLeading && !foundTrailing) {
		// Token absent (or only mid-message — which we don't strip).
		return { shouldSkip: false, cleanText: text };
	}

	// Token present at boundary. Suppress when remaining content fits the
	// ack ceiling — otherwise treat as a real reply that happened to bracket
	// itself with the token.
	if (stripped.length <= max) {
		return { shouldSkip: true, cleanText: '' };
	}
	return { shouldSkip: false, cleanText: stripped };
}
