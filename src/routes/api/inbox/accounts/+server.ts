import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { addAccount, listAccounts, removeAccount, getAccount, startAccountSync, stopAccountSync } from '$lib/inbox/index.js';
import type { InboxProvider } from '$lib/inbox/index.js';

const VALID_PROVIDERS: InboxProvider[] = ['icloud', 'gmail', 'outlook', 'imap'];

const PROVIDER_DEFAULTS: Record<string, { host: string; port: number }> = {
	icloud: { host: 'imap.mail.me.com', port: 993 },
	gmail: { host: 'imap.gmail.com', port: 993 },
	outlook: { host: 'outlook.office365.com', port: 993 },
};

/**
 * GET /api/inbox/accounts — list all email accounts
 */
export const GET: RequestHandler = async () => {
	const accounts = listAccounts();
	return json({ accounts });
};

/**
 * POST /api/inbox/accounts — add a new email account
 *   { provider, email, label?, credential, host?, port? }
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const provider = body.provider as string;
	const email = body.email as string;
	const credential = body.credential as string;
	const label = (body.label as string) || email;

	if (!provider || !VALID_PROVIDERS.includes(provider as InboxProvider)) {
		return json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, { status: 400 });
	}
	if (!email || !email.includes('@')) {
		return json({ error: 'valid email is required' }, { status: 400 });
	}
	if (!credential) {
		return json({ error: 'credential is required (password or OAuth token)' }, { status: 400 });
	}

	const defaults = PROVIDER_DEFAULTS[provider];
	const host = (body.host as string) || defaults?.host;
	const port = (body.port as number) || defaults?.port;

	if (!host) {
		return json({ error: 'host is required for custom IMAP provider' }, { status: 400 });
	}

	const id = randomUUID().slice(0, 8);

	try {
		const account = addAccount(
			{ id, label, provider: provider as InboxProvider, email, host, port },
			credential,
		);

		// Start sync worker for the new account
		startAccountSync(account);

		return json({ ok: true, account }, { status: 201 });
	} catch (err) {
		return json(
			{ error: `Failed to add account: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
};

/**
 * DELETE /api/inbox/accounts — remove an email account
 *   { id }
 */
export const DELETE: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const id = body.id as string;
	if (!id) {
		return json({ error: 'id is required' }, { status: 400 });
	}

	const account = getAccount(id);
	if (!account) {
		return json({ error: `Account "${id}" not found` }, { status: 404 });
	}

	stopAccountSync(id);
	removeAccount(id);
	return json({ ok: true, removed: id });
};
