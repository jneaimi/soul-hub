import type { RequestHandler } from './$types';
import { isRedirect, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeCode, accountOauthOverride, type ClientCreds } from '$lib/inbox/oauth.js';
import {
	addAccount,
	getAccount,
	listAccounts,
	startAccountSync,
	stopAccountSync,
	updateAccountCredential,
	getPendingOauthClient,
	deletePendingOauthClient,
} from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth/callback — Google OAuth2 callback
 *
 * Three modes, distinguished by the `state` query param:
 *
 *   1. state = "" (absent) — first-time link with the platform-env default
 *      OAuth client. Existing behavior.
 *
 *   2. state = "<8-hex>" matching an existing account id — Reauthorize an
 *      existing account. The account's per-account client (if any) is used
 *      for the code exchange; falls back to platform env. Existing behavior
 *      extended with the per-account override.
 *
 *   3. state = "pending:<uuid>" — first-time link with a custom OAuth
 *      client. The client_id/secret were stashed in pending_oauth_clients
 *      by /api/inbox/oauth/with-custom-client; this branch fetches them,
 *      exchanges the code, dedups, creates the account row WITH the client
 *      creds attached, and deletes the pending row. See ADR
 *      2026-05-11-per-account-oauth-clients.
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const state = url.searchParams.get('state');

	if (error) {
		return redirect(302, `/inbox?error=${encodeURIComponent(error)}`);
	}
	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}

	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;

	try {
		// ── Mode 3: pending custom-client first-time link ─────────────────
		if (state?.startsWith('pending:')) {
			const ephemeralId = state.slice('pending:'.length);
			const pending = getPendingOauthClient(ephemeralId);
			if (!pending) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						'OAuth client setup expired or unknown (over 1 hour or already consumed). Start the Add flow again.',
					)}`,
				);
			}

			const override: ClientCreds = {
				clientId: pending.clientId,
				clientSecret: pending.clientSecret,
			};

			const tokens = await exchangeCode(code, redirectUri, override);
			const email = await fetchUserEmail(tokens.accessToken);

			const duplicate = listAccounts().find(
				(a) => a.provider === 'gmail' && a.email === email,
			);
			if (duplicate) {
				deletePendingOauthClient(ephemeralId);
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Gmail account ${email} is already connected. Use Reauthorize on the existing row if the tokens expired.`,
					)}`,
				);
			}

			const credential = JSON.stringify({
				type: 'oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});

			const id = randomUUID().slice(0, 8);
			const account = addAccount(
				{ id, label: email, provider: 'gmail', email, host: 'imap.gmail.com', port: 993 },
				credential,
				{ clientId: pending.clientId, clientSecret: pending.clientSecret },
			);
			startAccountSync(account);
			deletePendingOauthClient(ephemeralId);
			return redirect(302, '/inbox?added=gmail');
		}

		// ── Mode 2: Re-link existing account ──────────────────────────────
		if (state) {
			const existing = getAccount(state);
			if (!existing) {
				return redirect(302, `/inbox?error=${encodeURIComponent('Account no longer exists')}`);
			}
			// Use the per-account override if the account has its own OAuth
			// client. Falls back to platform env when both columns are NULL.
			const override = accountOauthOverride(existing);
			const tokens = await exchangeCode(code, redirectUri, override);
			const email = await fetchUserEmail(tokens.accessToken);

			if (existing.email !== email) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Reauthorized with ${email} but account was ${existing.email}. Use the matching Google account.`,
					)}`,
				);
			}

			const credential = JSON.stringify({
				type: 'oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});
			updateAccountCredential(existing.id, credential);
			stopAccountSync(existing.id);
			const refreshed = getAccount(existing.id);
			if (refreshed) startAccountSync(refreshed);
			return redirect(302, `/inbox?reauthorized=${encodeURIComponent(email)}`);
		}

		// ── Mode 1: First-time link with platform-env default ─────────────
		const tokens = await exchangeCode(code, redirectUri);
		const email = await fetchUserEmail(tokens.accessToken);

		const duplicate = listAccounts().find(
			(a) => a.provider === 'gmail' && a.email === email,
		);
		if (duplicate) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					`Gmail account ${email} is already connected. Use Reauthorize on the existing row if the tokens expired.`,
				)}`,
			);
		}

		const credential = JSON.stringify({
			type: 'oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});

		const id = randomUUID().slice(0, 8);
		const account = addAccount(
			{ id, label: email, provider: 'gmail', email, host: 'imap.gmail.com', port: 993 },
			credential,
		);
		startAccountSync(account);
		return redirect(302, '/inbox?added=gmail');
	} catch (err) {
		// Successful redirects in the try-block also land here — let them
		// bubble up so SvelteKit can complete the 302.
		if (isRedirect(err)) throw err;
		const msg = err instanceof Error ? err.message : 'OAuth exchange failed';
		console.error('[inbox-oauth] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};

/**
 * Fetch the Google-authenticated user's email via the userinfo endpoint.
 * Requires openid + userinfo.email scopes (configured in oauth.ts).
 * Falls back to "gmail-user" on failure — same behavior as before.
 */
async function fetchUserEmail(accessToken: string): Promise<string> {
	try {
		const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (res.ok) {
			const userInfo = await res.json();
			return userInfo.email || 'gmail-user';
		}
	} catch {
		/* fall through */
	}
	return 'gmail-user';
}
