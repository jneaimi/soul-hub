import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeOutlookCode, getOutlookUserEmail } from '$lib/inbox/outlook.js';
import { addAccount, listAccounts, startAccountSync } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/outlook/callback — Microsoft OAuth2 callback
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const errorDesc = url.searchParams.get('error_description');

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

		// Dedup on (outlook, email). Symmetric to the Gmail callback
		// (ADR 2026-05-11-multiple-gmail-accounts) — prevents the
		// duplicate-row + IDLE-storm pathology if the operator hits
		// "Sign in with Microsoft" again with an already-connected
		// identity. The Reauthorize hint is currently aspirational
		// (Outlook in-place reauthorize lands with plan Open #2);
		// until then, the operator's recovery path is the "remove and
		// re-add" workaround from the settings modal (B2 stub).
		const duplicate = listAccounts().find(
			(a) => a.provider === 'outlook' && a.email === email,
		);
		if (duplicate) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					`Outlook account ${email} is already connected. Use the existing row's recovery options instead.`,
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
		const msg = err instanceof Error ? err.message : 'Outlook OAuth exchange failed';
		console.error('[inbox-outlook] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};
