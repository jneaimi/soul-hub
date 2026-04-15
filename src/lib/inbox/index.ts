/** Inbox module — public API */
export {
	getInboxDb, closeInboxDb,
	addAccount, getAccount, listAccounts, removeAccount,
	updateAccountStatus, updateAccountLastSync, getAccountCredential,
	upsertMessage, upsertMessages, listMessages, getMessage, getMessageCount,
	getSyncState, upsertSyncState, getInboxStats,
	type MessageListOptions,
} from './db.js';

export type {
	InboxAccount, InboxMessage, SyncState,
	InboxProvider, AccountStatus, StoredCredential,
} from './types.js';

export { encrypt, decrypt } from './crypto.js';

export { getAuthUrl, exchangeCode, refreshAccessToken, getValidToken, isTokenExpired } from './oauth.js';
export type { OAuthTokens } from './oauth.js';

export { getOutlookAuthUrl, exchangeOutlookCode, getValidOutlookToken, getOutlookUserEmail } from './outlook.js';
export type { OutlookTokens } from './outlook.js';

export {
	startSync, stopSync, startAccountSync, stopAccountSync,
	getSyncEmitter, getSyncStatus,
} from './sync.js';
