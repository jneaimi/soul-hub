import type { RequestHandler } from './$types';
import { isRedirect, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeOutlookCode, getOutlookUserEmail } from '$lib/inbox/outlook.js';
import {
	addAccount,
	getAccount,
	listAccounts,
	startAccountSync,
	stopAccountSync,
	updateAccountCredential,
} from '$lib/inbox/index.js';

/**
 * GET /api/inbox/outlook/callback — Microsoft OAuth2 callback
 *
 * Two modes, distinguished by the `state` query param. Mirrors the Gmail
 * callback (see `src/routes/api/inbox/oauth/callback/+server.ts`):
 *
 *   1. No state — first-time link. Dedup on (outlook, email) to prevent
 *      duplicate rows, then `addAccount` and `startAccountSync`.
 *   2. state = "<8-hex>" matching an existing account id — Reauthorize.
 *      Exchange the code, verify the email matches the existing row,
 *      `updateAccountCredential`, restart sync. Closes inbox-plan Open #2.
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const errorDesc = url.searchParams.get('error_description');
	const state = url.searchParams.get('state');

	if (error) {
		return redirect(302, `/inbox?error=${encodeURIComponent(errorDesc || error)}`);
	}

	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}

	const redirectUri = `${url.origin}/api/inbox/outlook/callback`;

	try {
		const tokens = await exchangeOutlookCode(code, redirectUri);
		const email = await getOutlookUserEmail(tokens.accessToken);

		// ── Mode 2: Re-link existing account ──
		if (state) {
			const existing = getAccount(state);
			if (!existing) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent('Account no longer exists')}`,
				);
			}
			if (existing.provider !== 'outlook') {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Account ${existing.id} is not an Outlook account`,
					)}`,
				);
			}
			if (existing.email !== email) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Reauthorized with ${email} but account was ${existing.email}. Use the matching Microsoft account.`,
					)}`,
				);
			}

			const credential = JSON.stringify({
				type: 'outlook-oauth2',
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

		// ── Mode 1: First-time link ──
		// Dedup on (outlook, email). Symmetric to the Gmail callback
		// (ADR 2026-05-11-multiple-gmail-accounts) — prevents the
		// duplicate-row + IDLE-storm pathology if the operator hits
		// "Sign in with Microsoft" again with an already-connected
		// identity. The Reauthorize hint now points to the working
		// in-place flow (Open #2 shipped 2026-05-12).
		const duplicate = listAccounts().find(
			(a) => a.provider === 'outlook' && a.email === email,
		);
		if (duplicate) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					`Outlook account ${email} is already connected. Use Reauthorize on the existing row if the tokens expired.`,
				)}`,
			);
		}

		const id = randomUUID().slice(0, 8);
		const credential = JSON.stringify({
			type: 'outlook-oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});

		const account = addAccount(
			{ id, label: email, provider: 'outlook', email, host: 'outlook.office365.com', port: 993 },
			credential,
		);

		startAccountSync(account);

		return redirect(302, '/inbox?added=outlook');
	} catch (err) {
		// Successful redirects in the try-block also land here.
		if (isRedirect(err)) throw err;
		const msg = err instanceof Error ? err.message : 'Outlook OAuth exchange failed';
		console.error('[inbox-outlook] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};
