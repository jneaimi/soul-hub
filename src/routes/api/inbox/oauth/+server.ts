import type { RequestHandler } from './$types';
import { isRedirect, json, redirect } from '@sveltejs/kit';
import { getAuthUrl } from '$lib/inbox/oauth.js';

/**
 * GET /api/inbox/oauth — start Gmail OAuth2 flow
 *   Redirects user to Google consent page.
 *   Optional ?account=<id> — re-link mode: the callback updates the existing
 *   account's credentials instead of creating a new row. Used by the
 *   "Reauthorize" button in the inbox settings modal (e.g. after Google's
 *   7-day Testing-mode refresh-token expiry).
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;
	const accountId = url.searchParams.get('account') || undefined;

	try {
		const authUrl = getAuthUrl(redirectUri, accountId);
		return redirect(302, authUrl);
	} catch (err) {
		// SvelteKit's redirect() throws a Redirect sentinel — let it through
		// so the framework can complete the 302. Anything else is a real error.
		if (isRedirect(err)) throw err;
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start OAuth flow' },
			{ status: 500 },
		);
	}
};
