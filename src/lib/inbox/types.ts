/** Inbox module types */

export type InboxProvider = 'icloud' | 'gmail' | 'outlook' | 'imap';

export type AccountStatus = 'connected' | 'syncing' | 'error' | 'disconnected';

export interface InboxAccount {
	id: string;
	label: string;
	provider: InboxProvider;
	email: string;
	host?: string;
	port?: number;
	status: AccountStatus;
	lastSync: number | null;
	lastError: string | null;
	createdAt: number;
	retentionDays: number;
	/** FK into `oauth_clients.id`. NULL for providers that don't use OAuth
	 *  (e.g. iCloud app-specific password). See ADR
	 *  2026-05-11-oauth-clients-as-first-class-connections. */
	oauthClientRef: string | null;
}

/** A reusable OAuth client identity (provider + credentials). Accounts
 *  reference these by FK. Managed via Settings → Connections. */
export interface OauthClient {
	id: string;
	provider: InboxProvider;
	label: string;
	clientId: string;
	clientSecretEncrypted: string;
	isDefault: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface InboxMessage {
	id: number;
	accountId: string;
	uid: number;
	uidValidity: number;
	folder: string;
	messageId: string | null;
	threadId: string | null;
	inReplyTo: string | null;
	subject: string;
	fromAddress: string;
	fromName: string | null;
	toAddress: string;
	dateSent: number | null;
	dateReceived: number;
	flags: string[];
	hasAttachments: boolean;
	bodyPreview: string;
	rawSize: number;
	syncedAt: number;
	processStatus: string;
	attachmentsMeta: AttachmentMeta[];
	attachmentCount: number;
	isFlagged: boolean;
}

export interface AttachmentMeta {
	filename: string;
	size: number;
	mimeType: string;
	part?: string;
	isInline: boolean;
}

export interface SyncState {
	accountId: string;
	folder: string;
	lastUid: number;
	uidValidity: number;
	lastSync: number;
}

/** Credential stored encrypted at rest */
export interface StoredCredential {
	type: 'password' | 'oauth2';
	/** For password: the app-specific password. For oauth2: JSON { accessToken, refreshToken, expiresAt } */
	data: string;
}
