import type { RequestHandler } from './$types';
import { json, redirect } from '@sveltejs/kit';
import { getOutlookAuthUrl } from '$lib/inbox/outlook.js';

/**
 * GET /api/inbox/outlook — start Outlook OAuth2 flow
 */
export const GET: RequestHandler = async ({ url }) => {
	const redirectUri = `${url.origin}/api/inbox/outlook/callback`;

	try {
		const authUrl = await getOutlookAuthUrl(redirectUri);
		return redirect(302, authUrl);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start Outlook OAuth flow' },
			{ status: 500 },
		);
	}
};
