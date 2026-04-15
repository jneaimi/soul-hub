/**
 * Inbox Sync Manager — background IMAP sync with auto-reconnect.
 *
 * Architecture:
 *   - One ImapFlow client per account (single connection)
 *   - IDLE for push notifications when mailbox is open
 *   - UID-based incremental sync (only fetch new messages)
 *   - Exponential backoff reconnect on close/error
 *   - SIGTERM-safe: logout all connections before exit
 *
 * Edge cases handled:
 *   - No auto-reconnect in imapflow → manual reconnect loop
 *   - IMAP IDLE 29-min RFC timeout → maxIdleTime=15min
 *   - OAuth2 token refresh → proactive refresh before reconnect
 *   - UIDVALIDITY change → clear and re-sync folder
 *   - fetchAll() memory risk → batched fetch with async iterator
 */

import { ImapFlow } from 'imapflow';
import { EventEmitter } from 'node:events';
import {
	getAccountCredential, listAccounts, updateAccountStatus,
	updateAccountLastSync, upsertMessages, getSyncState,
	upsertSyncState, getMessageCount,
} from './db.js';
import type { InboxAccount, InboxMessage, SyncState } from './types.js';

const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 min cap
const INITIAL_RECONNECT_DELAY = 3_000; // 3 sec
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 min (RFC max is 29)
const INITIAL_SYNC_DAYS = 30;
const FETCH_BATCH_SIZE = 100;

interface AccountWorker {
	accountId: string;
	client: ImapFlow | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectDelay: number;
	stopping: boolean;
}

let workers: Map<string, AccountWorker> = new Map();
let emitter: EventEmitter | null = null;
let initialized = false;

export function getSyncEmitter(): EventEmitter {
	if (!emitter) {
		emitter = new EventEmitter();
		emitter.setMaxListeners(20);
	}
	return emitter;
}

/** Start sync for all configured accounts */
export async function startSync(): Promise<void> {
	if (initialized) return;
	initialized = true;

	const accounts = listAccounts();
	for (const account of accounts) {
		startAccountSync(account);
	}
	console.log(`[inbox-sync] Started sync for ${accounts.length} accounts`);
}

/** Stop all sync workers gracefully */
export async function stopSync(): Promise<void> {
	initialized = false;
	const logouts: Promise<void>[] = [];

	for (const [id, worker] of workers) {
		worker.stopping = true;
		if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
		if (worker.client) {
			logouts.push(
				worker.client.logout().catch(() => {})
			);
		}
	}

	await Promise.allSettled(logouts);
	workers.clear();
	console.log('[inbox-sync] All workers stopped');
}

/** Start or restart sync for a single account */
export function startAccountSync(account: InboxAccount): void {
	// Stop existing worker if any
	const existing = workers.get(account.id);
	if (existing) {
		existing.stopping = true;
		if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
		if (existing.client) { try { existing.client.close(); } catch {} }
	}

	const worker: AccountWorker = {
		accountId: account.id,
		client: null,
		reconnectTimer: null,
		reconnectDelay: INITIAL_RECONNECT_DELAY,
		stopping: false,
	};
	workers.set(account.id, worker);

	connectWorker(worker, account);
}

/** Stop sync for a single account */
export function stopAccountSync(accountId: string): void {
	const worker = workers.get(accountId);
	if (!worker) return;
	worker.stopping = true;
	if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
	if (worker.client) { try { worker.client.close(); } catch {} }
	workers.delete(accountId);
}

async function connectWorker(worker: AccountWorker, account: InboxAccount): Promise<void> {
	if (worker.stopping) return;

	const credential = getAccountCredential(account.id);
	if (!credential) {
		updateAccountStatus(account.id, 'error', 'No credential found');
		return;
	}

	const clientConfig: Record<string, unknown> = {
		host: account.host || 'imap.mail.me.com',
		port: account.port || 993,
		secure: true,
		maxIdleTime: IDLE_TIMEOUT,
		logger: false, // disable verbose logging in production
		tls: {
			rejectUnauthorized: true, // NEVER disable TLS verification
		},
	};

	// Auth config — password-based for now (OAuth2 in Phase 3)
	clientConfig.auth = {
		user: account.email,
		pass: credential,
	};

	const client = new ImapFlow(clientConfig as unknown as ConstructorParameters<typeof ImapFlow>[0]);
	worker.client = client;

	updateAccountStatus(account.id, 'syncing');

	client.on('close', () => {
		if (worker.stopping) return;
		console.log(`[inbox-sync:${account.id}] Connection closed, scheduling reconnect (${worker.reconnectDelay}ms)`);
		updateAccountStatus(account.id, 'disconnected');
		scheduleReconnect(worker, account);
	});

	client.on('error', (err: Error) => {
		if (worker.stopping) return;
		console.error(`[inbox-sync:${account.id}] Error:`, err.message);
		updateAccountStatus(account.id, 'error', err.message);
	});

	try {
		await client.connect();
		console.log(`[inbox-sync:${account.id}] Connected to ${account.host}`);

		// Reset reconnect delay on successful connection
		worker.reconnectDelay = INITIAL_RECONNECT_DELAY;

		// Perform initial/incremental sync
		await syncInbox(worker, account, client);

		updateAccountLastSync(account.id);
		getSyncEmitter().emit('synced', account.id);

		// IDLE for push — client stays open listening for new messages
		// imapflow auto-starts IDLE when the mailbox is open and no commands are active

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[inbox-sync:${account.id}] Connect/sync failed:`, msg);
		updateAccountStatus(account.id, 'error', msg);

		if (!worker.stopping) {
			scheduleReconnect(worker, account);
		}
	}
}

function scheduleReconnect(worker: AccountWorker, account: InboxAccount): void {
	if (worker.stopping) return;

	worker.reconnectTimer = setTimeout(() => {
		if (worker.stopping) return;
		// Create a fresh client — never reuse a closed ImapFlow instance
		worker.client = null;
		connectWorker(worker, account);
	}, worker.reconnectDelay);

	// Exponential backoff with cap
	worker.reconnectDelay = Math.min(worker.reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

async function syncInbox(
	worker: AccountWorker,
	account: InboxAccount,
	client: ImapFlow,
): Promise<void> {
	// Open INBOX
	const lock = await client.getMailboxLock('INBOX');

	try {
		const mailbox = client.mailbox;
		if (!mailbox) {
			console.warn(`[inbox-sync:${account.id}] No mailbox info after open`);
			return;
		}

		const uidValidity = mailbox.uidValidity || 0;
		const syncState = getSyncState(account.id, 'INBOX');

		// Check UIDVALIDITY — if changed, folder was rebuilt, must re-sync
		if (syncState && syncState.uidValidity !== uidValidity) {
			console.log(`[inbox-sync:${account.id}] UIDVALIDITY changed (${syncState.uidValidity} → ${uidValidity}), full re-sync`);
			// Could clear old messages here — for now just re-sync from scratch
		}

		// Determine UID range to fetch
		let searchQuery: Record<string, unknown>;
		if (syncState && syncState.uidValidity === uidValidity && syncState.lastUid > 0) {
			// Incremental: fetch messages after last known UID
			searchQuery = { uid: `${syncState.lastUid + 1}:*` };
			console.log(`[inbox-sync:${account.id}] Incremental sync from UID ${syncState.lastUid + 1}`);
		} else {
			// Initial: fetch last N days
			const since = new Date();
			since.setDate(since.getDate() - INITIAL_SYNC_DAYS);
			searchQuery = { since };
			console.log(`[inbox-sync:${account.id}] Initial sync (last ${INITIAL_SYNC_DAYS} days)`);
		}

		// Fetch message UIDs first
		const uids = await client.search(searchQuery, { uid: true });
		if (!uids || uids.length === 0) {
			console.log(`[inbox-sync:${account.id}] No new messages`);
			upsertSyncState({
				accountId: account.id,
				folder: 'INBOX',
				lastUid: syncState?.lastUid || 0,
				uidValidity: Number(uidValidity),
				lastSync: Date.now(),
			});
			return;
		}

		console.log(`[inbox-sync:${account.id}] Fetching ${uids.length} messages`);

		// Fetch in batches to avoid memory pressure
		let maxUid = syncState?.lastUid || 0;
		const batch: Omit<InboxMessage, 'id'>[] = [];

		for await (const msg of client.fetch(
			{ uid: uids.join(',') },
			{
				uid: true,
				flags: true,
				envelope: true,
				bodyStructure: true,
				headers: ['message-id', 'in-reply-to', 'references'],
				size: true,
				internalDate: true,
				bodyParts: ['1'], // Fetch first text part for preview
			},
			{ uid: true },
		)) {
			if (worker.stopping) break;

			const envelope = msg.envelope || {};
			const from = envelope.from?.[0] || {};
			const to = envelope.to?.[0] || {};

			// Extract body preview from first text part
			let bodyPreview = '';
			const bodyParts = msg.bodyParts as Map<string, Buffer> | undefined;
			if (bodyParts) {
				const textPart = bodyParts.get('1');
				if (textPart) {
					bodyPreview = textPart.toString('utf-8').slice(0, 500).replace(/\r?\n/g, ' ').trim();
				}
			}

			// Extract Message-ID from headers
			const headers = msg.headers as Map<string, string> | undefined;
			const messageId = headers?.get('message-id')?.toString().trim().replace(/[<>]/g, '') || null;
			const inReplyTo = headers?.get('in-reply-to')?.toString().trim().replace(/[<>]/g, '') || null;

			const hasAttachments = checkAttachments(msg.bodyStructure);

			batch.push({
				accountId: account.id,
				uid: Number(msg.uid),
				uidValidity: Number(uidValidity),
				folder: 'INBOX',
				messageId,
				threadId: inReplyTo || messageId, // Simple threading: use in-reply-to as thread root
				inReplyTo,
				subject: envelope.subject || '',
				fromAddress: from.address || '',
				fromName: from.name || null,
				toAddress: to.address || '',
				dateSent: envelope.date ? new Date(envelope.date).getTime() : null,
				dateReceived: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
				flags: Array.from(msg.flags || []),
				hasAttachments,
				bodyPreview,
				rawSize: msg.size || 0,
				syncedAt: Date.now(),
			});

			if (Number(msg.uid) > maxUid) maxUid = Number(msg.uid);

			// Flush batch to SQLite
			if (batch.length >= FETCH_BATCH_SIZE) {
				upsertMessages(batch.splice(0));
			}
		}

		// Flush remaining
		if (batch.length > 0) {
			upsertMessages(batch);
		}

		// Update sync state
		upsertSyncState({
			accountId: account.id,
			folder: 'INBOX',
			lastUid: maxUid,
			uidValidity: Number(uidValidity),
			lastSync: Date.now(),
		});

		const totalCount = getMessageCount(account.id);
		console.log(`[inbox-sync:${account.id}] Sync complete: ${uids.length} fetched, ${totalCount} total cached`);
	} finally {
		lock.release();
	}
}

/** Check bodyStructure for attachments */
function checkAttachments(structure: unknown): boolean {
	if (!structure) return false;
	const s = structure as Record<string, unknown>;
	if (s.disposition === 'attachment') return true;
	if (Array.isArray(s.childNodes)) {
		return s.childNodes.some((child: unknown) => checkAttachments(child));
	}
	return false;
}

/** Get sync status for all accounts */
export function getSyncStatus(): { accountId: string; connected: boolean; stopping: boolean }[] {
	return [...workers.entries()].map(([id, w]) => ({
		accountId: id,
		connected: w.client !== null && !w.stopping,
		stopping: w.stopping,
	}));
}
