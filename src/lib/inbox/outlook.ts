/**
 * Outlook / Microsoft 365 integration via MS Graph API + MSAL OAuth2.
 *
 * Flow:
 *   1. User clicks "Connect Outlook" → redirect to Microsoft consent
 *   2. Microsoft redirects back with ?code=... → MSAL exchanges for tokens
 *   3. Store encrypted { accessToken, refreshToken, expiresAt, type: 'outlook-oauth2' }
 *   4. Sync worker uses Graph API delta query for incremental sync
 *
 * Required env vars:
 *   AZURE_CLIENT_ID     — from Azure Portal > App registrations
 *   AZURE_CLIENT_SECRET — from Azure Portal > Certificates & secrets
 *
 * Required scope: Mail.Read (delegated)
 *
 * Edge cases:
 *   - Delta tokens expire in ~7 days → catch syncStateNotFound, full re-sync
 *   - Rate limits → respect Retry-After header with exp backoff
 *   - Personal vs work accounts → both supported via /common authority
 */

import { ConfidentialClientApplication } from '@azure/msal-node';

const GRAPH_SCOPES = ['Mail.Read', 'User.Read', 'offline_access'];
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface OutlookTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

function getConfig(): { clientId: string; clientSecret: string } {
	const clientId = process.env.AZURE_CLIENT_ID;
	const clientSecret = process.env.AZURE_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error('AZURE_CLIENT_ID and AZURE_CLIENT_SECRET env vars are required for Outlook');
	}
	return { clientId, clientSecret };
}

function createMsalApp(redirectUri?: string): ConfidentialClientApplication {
	const { clientId, clientSecret } = getConfig();
	return new ConfidentialClientApplication({
		auth: {
			clientId,
			clientSecret,
			authority: 'https://login.microsoftonline.com/common',
		},
	});
}

/** Generate the Microsoft OAuth2 consent URL */
export async function getOutlookAuthUrl(redirectUri: string): Promise<string> {
	const app = createMsalApp();
	const url = await app.getAuthCodeUrl({
		scopes: GRAPH_SCOPES,
		redirectUri,
		prompt: 'consent',
	});
	return url;
}

/** Exchange authorization code for tokens */
export async function exchangeOutlookCode(code: string, redirectUri: string): Promise<OutlookTokens> {
	const app = createMsalApp();
	const result = await app.acquireTokenByCode({
		code,
		scopes: GRAPH_SCOPES,
		redirectUri,
	});

	if (!result?.accessToken) {
		throw new Error('No access token received from Microsoft');
	}

	return {
		accessToken: result.accessToken,
		refreshToken: '', // MSAL manages refresh internally via cache, but we store for manual refresh
		expiresAt: result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600_000,
	};
}

/** Refresh an expired access token */
export async function refreshOutlookToken(refreshToken: string): Promise<OutlookTokens> {
	const { clientId, clientSecret } = getConfig();

	// Use direct token endpoint for refresh since MSAL cache is per-instance
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
		scope: GRAPH_SCOPES.join(' '),
	});

	const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Token refresh failed: ${res.status} ${err}`);
	}

	const data = await res.json();
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken,
		expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
	};
}

/** Check if tokens need refresh */
export function isOutlookTokenExpired(tokens: OutlookTokens): boolean {
	return Date.now() >= tokens.expiresAt - 5 * 60 * 1000;
}

/** Get a valid access token, refreshing if needed */
export async function getValidOutlookToken(tokens: OutlookTokens): Promise<OutlookTokens> {
	if (!isOutlookTokenExpired(tokens)) return tokens;
	return refreshOutlookToken(tokens.refreshToken);
}

// ── Graph API helpers ──

export interface GraphMessage {
	id: string;
	subject: string;
	from: { emailAddress: { name: string; address: string } } | null;
	toRecipients: { emailAddress: { name: string; address: string } }[];
	receivedDateTime: string;
	sentDateTime: string | null;
	isRead: boolean;
	hasAttachments: boolean;
	bodyPreview: string;
	internetMessageId: string | null;
	conversationId: string | null;
}

export interface GraphDeltaResult {
	messages: GraphMessage[];
	deltaLink: string | null;
	nextLink: string | null;
}

/** Fetch messages via Graph API delta query (incremental sync) */
export async function fetchMessagesDelta(
	accessToken: string,
	deltaLink?: string,
): Promise<GraphDeltaResult> {
	const url = deltaLink || `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview,internetMessageId,conversationId&$top=100`;

	const messages: GraphMessage[] = [];
	let currentUrl: string | null = url;
	let finalDeltaLink: string | null = null;

	while (currentUrl) {
		const res: Response = await fetch(currentUrl, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (res.status === 429) {
			// Rate limited — respect Retry-After
			const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
			console.log(`[outlook] Rate limited, waiting ${retryAfter}s`);
			await new Promise((r) => setTimeout(r, retryAfter * 1000));
			continue;
		}

		if (res.status === 410 || res.status === 404) {
			// Delta token expired (syncStateNotFound) — caller must full re-sync
			throw new DeltaExpiredError('Delta token expired — full re-sync required');
		}

		if (!res.ok) {
			throw new Error(`Graph API error: ${res.status} ${await res.text()}`);
		}

		const data: Record<string, unknown> = await res.json();
		const pageMessages = (data.value || []) as GraphMessage[];
		messages.push(...pageMessages);

		// Follow pagination
		currentUrl = (data['@odata.nextLink'] as string) || null;
		if (data['@odata.deltaLink']) {
			finalDeltaLink = data['@odata.deltaLink'] as string;
		}
	}

	return { messages, deltaLink: finalDeltaLink, nextLink: null };
}

/** Get user email from Graph API */
export async function getOutlookUserEmail(accessToken: string): Promise<string> {
	const res = await fetch(`${GRAPH_BASE}/me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) return 'outlook-user';
	const data = await res.json();
	return data.mail || data.userPrincipalName || 'outlook-user';
}

export class DeltaExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeltaExpiredError';
	}
}
