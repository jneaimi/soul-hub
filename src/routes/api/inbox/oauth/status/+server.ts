import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';

/**
 * GET /api/inbox/oauth/status — is Gmail OAuth configured?
 *   Used by the Add-Gmail UI to decide whether to render the "Configure in
 *   Settings" call-to-action or the live "Sign in with Google" button. Also
 *   returns the redirect URI the operator must register in Google Cloud
 *   Console (it's origin-dependent, so the client can't hardcode it).
 *
 *   The endpoint only reports presence — it never echoes the actual secret.
 */
export const GET: RequestHandler = async ({ url }) => {
	const configured = Boolean(
		process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
	);
	return json({
		configured,
		redirectUri: `${url.origin}/api/inbox/oauth/callback`,
	});
};
