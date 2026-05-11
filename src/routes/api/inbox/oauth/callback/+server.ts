import type { RequestHandler } from './$types';
import { isRedirect, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeCode } from '$lib/inbox/oauth.js';
import {
	addAccount,
	getAccount,
	startAccountSync,
	stopAccountSync,
	updateAccountCredential,
} from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth/callback — Google OAuth2 callback
 *   Google redirects here with ?code=... after consent.
 *   - First-time link: creates a new account row + starts sync.
 *   - Re-link (state=<account-id>): refreshes credentials on the existing
 *     account row and restarts its sync worker so the new tokens take effect
 *     immediately. Used by the "Reauthorize" button after refresh-token
 *     expiry / revocation.
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const state = url.searchParams.get('state'); // account id when re-linking

	if (error) {
		return redirect(302, `/inbox?error=${encodeURIComponent(error)}`);
	}
	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}

	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;

	try {
		const tokens = await exchangeCode(code, redirectUri);

		// Get user's email from the access token (userinfo endpoint).
		// Requires openid + userinfo.email scopes (configured in oauth.ts).
		const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});

		let email = 'gmail-user';
		if (userInfoRes.ok) {
			const userInfo = await userInfoRes.json();
			email = userInfo.email || email;
		}

		const credential = JSON.stringify({
			type: 'oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});

		// Re-link mode: existing account in `state`.
		if (state) {
			const existing = getAccount(state);
			if (!existing) {
				return redirect(302, `/inbox?error=${encodeURIComponent('Account no longer exists')}`);
			}
			if (existing.email !== email) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Reauthorized with ${email} but account was ${existing.email}. Use the matching Google account.`,
					)}`,
				);
			}
			updateAccountCredential(existing.id, credential);
			stopAccountSync(existing.id);
			const refreshed = getAccount(existing.id);
			if (refreshed) startAccountSync(refreshed);
			return redirect(302, `/inbox?reauthorized=${encodeURIComponent(email)}`);
		}

		// First-time link.
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
