import type { RequestHandler } from './$types';
import { json, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeCode } from '$lib/inbox/oauth.js';
import { addAccount, startAccountSync } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth/callback — Google OAuth2 callback
 *   Google redirects here with ?code=... after consent
 *   Exchanges code for tokens, creates account, starts sync
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (error) {
		// User denied consent or other OAuth error
		return redirect(302, `/inbox?error=${encodeURIComponent(error)}`);
	}

	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}

	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;

	try {
		const tokens = await exchangeCode(code, redirectUri);

		// Get user's email from the access token (userinfo endpoint)
		const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
		});

		let email = 'gmail-user';
		if (userInfoRes.ok) {
			const userInfo = await userInfoRes.json();
			email = userInfo.email || email;
		}

		const id = randomUUID().slice(0, 8);

		// Store tokens as JSON credential (encrypted by addAccount)
		const credential = JSON.stringify({
			type: 'oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});

		const account = addAccount(
			{ id, label: email, provider: 'gmail', email, host: 'imap.gmail.com', port: 993 },
			credential,
		);

		// Start sync worker
		startAccountSync(account);

		return redirect(302, '/inbox?added=gmail');
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'OAuth exchange failed';
		console.error('[inbox-oauth] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};
