import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { insertPendingOauthClient } from '$lib/inbox/index.js';
import { getAuthUrl } from '$lib/inbox/oauth.js';

/**
 * POST /api/inbox/oauth/with-custom-client
 *
 * First-time-link Gmail consent flow using a per-account OAuth client
 * (different `client_id` / `client_secret` than the platform-env default).
 *
 * Stashes the creds in a short-lived `pending_oauth_clients` row, returns
 * an auth URL with state=`pending:<ephemeral_id>`. The callback at
 * `/api/inbox/oauth/callback` recognises the prefix, looks up the creds,
 * exchanges the code, and persists the client_id/secret onto the new
 * account row.
 *
 * See ADR 2026-05-11-per-account-oauth-clients for the full design and
 * threat model around the ephemeral state.
 *
 * Response:
 *   200 { authUrl }
 *   400 missing or invalid clientId/clientSecret
 */
export const POST: RequestHandler = async ({ request, url }) => {
	let body: { clientId?: string; clientSecret?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const clientId = (body.clientId || '').trim();
	const clientSecret = (body.clientSecret || '').trim();
	if (!clientId || !clientSecret) {
		return json(
			{ error: 'clientId and clientSecret are both required' },
			{ status: 400 },
		);
	}

	const ephemeralId = insertPendingOauthClient('gmail', clientId, clientSecret);
	const redirectUri = `${url.origin}/api/inbox/oauth/callback`;
	const authUrl = getAuthUrl(redirectUri, `pending:${ephemeralId}`, {
		clientId,
		clientSecret,
	});

	return json({ authUrl });
};
