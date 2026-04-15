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
