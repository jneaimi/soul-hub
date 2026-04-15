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
