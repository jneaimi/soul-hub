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
	/** Per-account OAuth client id override. NULL means use platform env.
	 *  Both this and `oauthClientSecretEncrypted` must be set or both NULL.
	 *  See ADR 2026-05-11-per-account-oauth-clients. */
	oauthClientId: string | null;
	/** Encrypted with the same AES-256-GCM helper as `encryptedCredential`. */
	oauthClientSecretEncrypted: string | null;
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
