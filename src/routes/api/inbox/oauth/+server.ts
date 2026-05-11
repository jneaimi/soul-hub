import type { RequestHandler } from './$types';
import { isRedirect, json, redirect } from '@sveltejs/kit';
import { getAuthUrl, accountOauthOverride } from '$lib/inbox/oauth.js';
import { getAccount } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth — start Gmail OAuth2 flow
 *
 *   Redirects user to Google consent page.
 *
 *   Optional ?account=<id> — re-link mode: the callback updates the existing
 *   account's credentials instead of creating a new row. Used by the
 *   "Reauthorize" button in the inbox settings modal (e.g. after Google's
 *   7-day Testing-mode refresh-token expiry).
 *
 *   If the account has a per-account OAuth client override (see ADR
 *   2026-05-11-per-account-oauth-clients), the consent URL is generated
 *   against that client. Otherwise the platform-env default is used.
 *
 *   For first-time link with a custom client, use POST
 *   /api/inbox/oauth/with-custom-client instead — it stashes the creds
 *   in a pending row before redirecting.
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;
	const accountId = url.searchParams.get('account') || undefined;

	try {
		// Re-link path: pull the account's per-account override (if any).
		// For brand-new first-time link with platform default, override is
		// undefined and getAuthUrl uses process.env (existing behavior).
		const override = accountId
			? accountOauthOverride(getAccount(accountId) ?? { oauthClientId: null, oauthClientSecretEncrypted: null })
			: undefined;
		const authUrl = getAuthUrl(redirectUri, accountId, override);
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
