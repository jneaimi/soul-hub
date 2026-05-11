/** Inbox module — public API */
export {
	getInboxDb, closeInboxDb,
	addAccount, getAccount, listAccounts, removeAccount,
	updateAccountStatus, updateAccountLastSync, getAccountCredential,
	upsertMessage, upsertMessages, listMessages, getMessage, getMessageCount,
	getSyncState, upsertSyncState, getInboxStats,
	pruneOldMessages, deleteMessagesByFolder, updateAccountSettings, updateAccountCredential,
	listOauthClients, getOauthClient, getDefaultOauthClient, countAccountsUsingOauthClient,
	createOauthClient, updateOauthClient, deleteOauthClient, touchOauthClientUsage,
	// Layer 2 filter
	listFilterRules, getFilterRule, insertFilterRule, setFilterRuleEnabled, deleteFilterRule,
	getFilterCache, setFilterCache, bumpFilterCacheHit,
	applyClassification, setMessageHeaderSignals, markMessageProcessed,
	listMessagesForFiltering, reclassifyBySignature, getFilterStats,
	type MessageListOptions,
} from './db.js';

export type {
	InboxAccount, InboxMessage, SyncState,
	InboxProvider, AccountStatus, StoredCredential,
	AttachmentMeta, OauthClient,
	FilterCategory, FilterRule, FilterRuleMatchType, FilterCacheEntry,
	HeaderSignals,
} from './types.js';
export { CATEGORY_TO_STATUS } from './types.js';

export {
	startFilterWorker, stopFilterWorker, getFilterWorkerStatus,
	correctClassification,
} from './filter.js';
export { cacheSignature } from './filter-rules.js';

export { encrypt, decrypt } from './crypto.js';

export {
	getAuthUrl, exchangeCode, refreshAccessToken, getValidToken, isTokenExpired,
	resolveClientCredsByRef, resolveClientCredsForAccount,
} from './oauth.js';
export type { OAuthTokens, ClientCreds } from './oauth.js';

export { getOutlookAuthUrl, exchangeOutlookCode, getValidOutlookToken, getOutlookUserEmail } from './outlook.js';
export type { OutlookTokens } from './outlook.js';

export {
	startSync, stopSync, startAccountSync, stopAccountSync,
	getSyncEmitter, getSyncStatus,
} from './sync.js';
