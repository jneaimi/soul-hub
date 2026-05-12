import type { RequestHandler } from './$types';
import { isRedirect, json, redirect } from '@sveltejs/kit';
import { getOutlookAuthUrl } from '$lib/inbox/outlook.js';
import { getAccount } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/outlook — start Outlook OAuth2 flow
 *
 * Two modes, mirroring the Gmail handler:
 *
 *   1. No params — first-time link. `state` is omitted; the callback
 *      treats the absence of state as "create a new account."
 *   2. ?account=<id> — re-link an existing account (Reauthorize). State
 *      becomes the account id; the callback's Mode 2 branch updates the
 *      existing row's credential instead of creating a new account.
 */
export const GET: RequestHandler = async ({ url }) => {
	const redirectUri = `${url.origin}/api/inbox/outlook/callback`;
	const accountId = url.searchParams.get('account') || undefined;

	try {
		if (accountId) {
			const account = getAccount(accountId);
			if (!account) {
				return json({ error: 'Account not found' }, { status: 404 });
			}
			if (account.provider !== 'outlook') {
				return json(
					{ error: `Account ${accountId} is not an Outlook account` },
					{ status: 400 },
				);
			}
			const authUrl = await getOutlookAuthUrl(redirectUri, accountId);
			return redirect(302, authUrl);
		}

		const authUrl = await getOutlookAuthUrl(redirectUri);
		return redirect(302, authUrl);
	} catch (err) {
		// SvelteKit's redirect() throws a Redirect sentinel — let it through.
		if (isRedirect(err)) throw err;
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start Outlook OAuth flow' },
			{ status: 500 },
		);
	}
};
