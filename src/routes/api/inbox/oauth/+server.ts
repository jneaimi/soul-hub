import type { RequestHandler } from './$types';
import { json, redirect } from '@sveltejs/kit';
import { getAuthUrl } from '$lib/inbox/oauth.js';

/**
 * GET /api/inbox/oauth — start Gmail OAuth2 flow
 *   Redirects user to Google consent page
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;

	try {
		const authUrl = getAuthUrl(redirectUri);
		return redirect(302, authUrl);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start OAuth flow' },
			{ status: 500 },
		);
	}
};
