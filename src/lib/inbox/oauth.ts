/**
 * OAuth2 helpers for Gmail IMAP access.
 *
 * Flow:
 *   1. User clicks "Add Gmail" → redirect to Google consent
 *   2. Google redirects back with ?code=... → exchange for tokens
 *   3. Store encrypted { accessToken, refreshToken, expiresAt } in accounts table
 *   4. Sync worker reads credential, refreshes if expired, connects with accessToken
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID     — from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET — from Google Cloud Console
 *
 * Required scope: https://mail.google.com/ (NOT gmail.readonly — won't work for IMAP)
 */

import { OAuth2Client } from 'google-auth-library';

const GMAIL_IMAP_SCOPE = 'https://mail.google.com/';

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // unix ms
}

function getClientConfig(): { clientId: string; clientSecret: string } {
	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are required for Gmail OAuth2');
	}
	return { clientId, clientSecret };
}

function createClient(redirectUri: string): OAuth2Client {
	const { clientId, clientSecret } = getClientConfig();
	return new OAuth2Client(clientId, clientSecret, redirectUri);
}

/** Generate the Google OAuth2 consent URL */
export function getAuthUrl(redirectUri: string, state?: string): string {
	const client = createClient(redirectUri);
	return client.generateAuthUrl({
		access_type: 'offline', // get refresh token
		prompt: 'consent', // force consent to always get refresh token
		scope: [GMAIL_IMAP_SCOPE],
		state,
	});
}

/** Exchange authorization code for tokens */
export async function exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
	const client = createClient(redirectUri);
	const { tokens } = await client.getToken(code);

	if (!tokens.access_token) {
		throw new Error('No access token received from Google');
	}
	if (!tokens.refresh_token) {
		throw new Error('No refresh token received. Ensure access_type=offline and prompt=consent');
	}

	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: tokens.expiry_date || (Date.now() + 3600_000), // default 1h if not provided
	};
}

/** Refresh an expired access token using the refresh token */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
	const { clientId, clientSecret } = getClientConfig();
	const client = new OAuth2Client(clientId, clientSecret);
	client.setCredentials({ refresh_token: refreshToken });

	const { credentials } = await client.refreshAccessToken();

	if (!credentials.access_token) {
		throw new Error('Failed to refresh access token');
	}

	return {
		accessToken: credentials.access_token,
		refreshToken: credentials.refresh_token || refreshToken, // Google may not return a new refresh token
		expiresAt: credentials.expiry_date || (Date.now() + 3600_000),
	};
}

/** Check if tokens need refresh (expired or expiring within 5 min) */
export function isTokenExpired(tokens: OAuthTokens): boolean {
	return Date.now() >= tokens.expiresAt - 5 * 60 * 1000; // 5 min buffer
}

/** Get a valid access token, refreshing if needed. Returns updated tokens. */
export async function getValidToken(tokens: OAuthTokens): Promise<OAuthTokens> {
	if (!isTokenExpired(tokens)) {
		return tokens;
	}
	return refreshAccessToken(tokens.refreshToken);
}
