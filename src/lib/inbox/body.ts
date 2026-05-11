/**
 * Lazy full-body fetch for inbox messages.
 *
 * The sync worker deliberately stores only envelope + 500-char preview +
 * attachment metadata — see ADR 2026-04-16. Pulling full RFC822 bodies on
 * every sync would bloat the DB and slow IDLE. Instead, the body is fetched
 * on demand via this module and the GET /api/inbox/messages/[id]/body
 * endpoint.
 *
 * For v1 we open a fresh ImapFlow connection per request. Fine for
 * operator-driven UI clicks. If Layer 2 / Layer 3 agents start hammering
 * this endpoint, switch to a small connection pool keyed by account id.
 *
 * Outlook (MS Graph) bodies need a separate path because the sync layer
 * hashes the Graph string id into messages.uid (lossy) — see plan Open #6.
 * Until that adds an external_id column, Outlook body fetch is 501.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getValidToken } from './oauth.js';
import { encrypt } from './crypto.js';
import { getAccountCredential, getInboxDb } from './db.js';
import type { InboxAccount, InboxMessage } from './types.js';

export interface MessageBody {
	text: string;
	html: string | null;
	fetchedAt: number;
}

/**
 * Fetch the full body of an IMAP message and return parsed text + html.
 * Opens a short-lived ImapFlow connection; respects the same OAuth2 refresh
 * + persist semantics as the sync worker.
 *
 * Throws on any upstream failure — callers surface as 502 in the endpoint.
 */
export async function fetchImapBody(
	account: InboxAccount,
	message: Pick<InboxMessage, 'uid' | 'folder'>,
): Promise<MessageBody> {
	const credential = getAccountCredential(account.id);
	if (!credential) throw new Error('Account has no stored credential');

	const clientConfig: Record<string, unknown> = {
		host: account.host || 'imap.mail.me.com',
		port: account.port || 993,
		secure: true,
		logger: false,
		tls: { rejectUnauthorized: true },
	};

	// Same auth discrimination as sync.ts:connectWorker. Kept inline to avoid
	// touching the sync path in this commit; consolidate into a shared
	// buildImapClientConfig helper next time either side changes.
	let parsedCred: { type?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | null = null;
	try { parsedCred = JSON.parse(credential); } catch { /* plain password */ }

	if (parsedCred?.type === 'oauth2' && parsedCred.refreshToken) {
		const tokens = await getValidToken({
			accessToken: parsedCred.accessToken || '',
			refreshToken: parsedCred.refreshToken,
			expiresAt: parsedCred.expiresAt || 0,
		});
		// Persist refreshed tokens back to DB if changed.
		if (tokens.accessToken !== parsedCred.accessToken) {
			const updatedCred = JSON.stringify({
				type: 'oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});
			const db = getInboxDb();
			db.prepare('UPDATE accounts SET encrypted_credential = ? WHERE id = ?')
				.run(encrypt(updatedCred), account.id);
		}
		clientConfig.auth = { user: account.email, accessToken: tokens.accessToken };
	} else {
		clientConfig.auth = { user: account.email, pass: credential };
	}

	const client = new ImapFlow(clientConfig as unknown as ConstructorParameters<typeof ImapFlow>[0]);
	await client.connect();
	try {
		const lock = await client.getMailboxLock(message.folder || 'INBOX');
		try {
			const result = await client.fetchOne(
				String(message.uid),
				{ source: true },
				{ uid: true },
			);
			if (!result || !result.source) {
				throw new Error('Message source not returned by server (possibly deleted upstream)');
			}
			const parsed = await simpleParser(result.source as Buffer);
			return {
				text: parsed.text || '',
				html: typeof parsed.html === 'string' ? parsed.html : null,
				fetchedAt: Date.now(),
			};
		} finally {
			lock.release();
		}
	} finally {
		try { await client.logout(); } catch { /* best-effort close */ }
	}
}
