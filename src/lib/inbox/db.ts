/**
 * Inbox SQLite database — email cache with FTS5 search.
 *
 * Schema:
 *   accounts       — email account configs (credentials encrypted)
 *   oauth_clients  — reusable OAuth client identities (Connections)
 *   messages       — cached email headers + preview
 *   sync_state     — per-account/folder sync watermarks
 *   messages_fts   — FTS5 virtual table for search
 *
 * Uses WAL mode for concurrent SvelteKit reads + sync worker writes.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
	InboxAccount, InboxMessage, SyncState, InboxProvider, AccountStatus,
	OauthClient,
} from './types.js';
import { encrypt, decrypt } from './crypto.js';
import { soulHubDataDir } from '../paths.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	return resolve(soulHubDataDir(), 'inbox.db');
}

export function getInboxDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());

	// Performance pragmas for concurrent access
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('temp_store = MEMORY');
	db.pragma('busy_timeout = 5000');
	db.pragma('wal_autocheckpoint = 1000');

	// Run migrations
	migrate(db);

	return db;
}

export function closeInboxDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS accounts (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				provider TEXT NOT NULL,
				email TEXT NOT NULL,
				host TEXT,
				port INTEGER,
				encrypted_credential TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'disconnected',
				last_sync INTEGER,
				last_error TEXT,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				uid INTEGER NOT NULL,
				uid_validity INTEGER NOT NULL,
				folder TEXT NOT NULL,
				message_id TEXT,
				thread_id TEXT,
				in_reply_to TEXT,
				subject TEXT NOT NULL DEFAULT '',
				from_address TEXT NOT NULL DEFAULT '',
				from_name TEXT,
				to_address TEXT NOT NULL DEFAULT '',
				date_sent INTEGER,
				date_received INTEGER NOT NULL,
				flags TEXT NOT NULL DEFAULT '[]',
				has_attachments INTEGER NOT NULL DEFAULT 0,
				body_preview TEXT NOT NULL DEFAULT '',
				raw_size INTEGER NOT NULL DEFAULT 0,
				content_hash TEXT,
				synced_at INTEGER NOT NULL,
				UNIQUE(account_id, uid, folder, uid_validity)
			);

			CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
			CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_received DESC);
			CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id) WHERE message_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;

			CREATE TABLE IF NOT EXISTS sync_state (
				account_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				last_uid INTEGER NOT NULL DEFAULT 0,
				uid_validity INTEGER NOT NULL DEFAULT 0,
				last_sync INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY(account_id, folder)
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				subject, body_preview, from_address,
				content='messages',
				content_rowid='id'
			);

			-- Triggers to keep FTS in sync
			CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts(rowid, subject, body_preview, from_address)
				VALUES (new.id, new.subject, new.body_preview, new.from_address);
			END;

			CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, subject, body_preview, from_address)
				VALUES ('delete', old.id, old.subject, old.body_preview, old.from_address);
			END;

			CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, subject, body_preview, from_address)
				VALUES ('delete', old.id, old.subject, old.body_preview, old.from_address);
				INSERT INTO messages_fts(rowid, subject, body_preview, from_address)
				VALUES (new.id, new.subject, new.body_preview, new.from_address);
			END;
		`);
		db.pragma(`user_version = 1`);
	}

	if (version < 2) {
		db.exec(`
			ALTER TABLE accounts ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30;

			ALTER TABLE messages ADD COLUMN process_status TEXT NOT NULL DEFAULT 'new';
			ALTER TABLE messages ADD COLUMN attachments_meta TEXT NOT NULL DEFAULT '[]';
			ALTER TABLE messages ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE messages ADD COLUMN is_flagged INTEGER NOT NULL DEFAULT 0;

			CREATE INDEX IF NOT EXISTS idx_messages_status_date ON messages(process_status, date_received DESC);
			CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(is_flagged) WHERE is_flagged = 1;
		`);
		db.pragma(`user_version = 2`);
	}

	if (version < 3) {
		// UNIQUE (provider, email) belt-and-suspenders. The application-level
		// dedup in OAuth callbacks + POST handler is the primary UX path
		// (returns helpful "Use Reauthorize / Reset Password" messages).
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_email
			ON accounts(provider, email);
		`);
		db.pragma(`user_version = 3`);
	}

	if (version < 4) {
		// Migration #4 (per-account inline OAuth override) — see superseded
		// ADR 2026-05-11-per-account-oauth-clients. We still run it here so
		// any partial-deploy DBs that landed between migrations have the
		// columns to drop in migration #5. Migration #5 is the live model.
		db.exec(`
			ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT;
			ALTER TABLE accounts ADD COLUMN oauth_client_secret_encrypted TEXT;

			CREATE TABLE IF NOT EXISTS pending_oauth_clients (
				ephemeral_id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				client_id TEXT NOT NULL,
				client_secret_encrypted TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_pending_oauth_clients_created
				ON pending_oauth_clients(created_at);
		`);
		db.pragma(`user_version = 4`);
	}

	if (version < 5) {
		// Promote OAuth clients to first-class objects (Connections).
		// See ADR 2026-05-11-oauth-clients-as-first-class-connections.
		//
		// 1. CREATE oauth_clients
		// 2. ADD accounts.oauth_client_ref (FK)
		// 3. Seed Default Gmail client from process.env if present
		// 4. Backfill any inline overrides into oauth_clients rows + relink
		// 5. Default-link existing Gmail accounts at the seeded Default
		// 6. DROP pending_oauth_clients
		// 7. DROP accounts.oauth_client_id + oauth_client_secret_encrypted
		const tx = db.transaction(() => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS oauth_clients (
					id TEXT PRIMARY KEY,
					provider TEXT NOT NULL,
					label TEXT NOT NULL,
					client_id TEXT NOT NULL,
					client_secret_encrypted TEXT NOT NULL,
					is_default INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					last_used_at INTEGER
				);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_provider_client_id
					ON oauth_clients(provider, client_id);
				CREATE INDEX IF NOT EXISTS idx_oauth_clients_provider_default
					ON oauth_clients(provider, is_default);

				ALTER TABLE accounts ADD COLUMN oauth_client_ref TEXT REFERENCES oauth_clients(id);
			`);

			const now = Date.now();

			// Seed Default Gmail client from platform env, if present.
			const envClientId = process.env.GOOGLE_CLIENT_ID?.trim();
			const envClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
			let defaultGmailId: string | null = null;
			if (envClientId && envClientSecret) {
				defaultGmailId = randomUUID();
				db.prepare(`
					INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
					VALUES (?, 'gmail', 'Default', ?, ?, 1, ?)
				`).run(defaultGmailId, envClientId, encrypt(envClientSecret), now);
				console.log('[inbox-migration] Seeded Default Gmail OAuth client from platform env');
			}

			// Backfill inline overrides → oauth_clients rows.
			const inlineOverrideAccounts = db.prepare(`
				SELECT id, label, provider, oauth_client_id, oauth_client_secret_encrypted
				FROM accounts
				WHERE oauth_client_id IS NOT NULL AND oauth_client_secret_encrypted IS NOT NULL
			`).all() as Array<{
				id: string;
				label: string;
				provider: string;
				oauth_client_id: string;
				oauth_client_secret_encrypted: string;
			}>;

			for (const acc of inlineOverrideAccounts) {
				// Check if a row already exists for this (provider, client_id).
				const existing = db.prepare(
					`SELECT id FROM oauth_clients WHERE provider = ? AND client_id = ?`,
				).get(acc.provider, acc.oauth_client_id) as { id: string } | undefined;
				let ref: string;
				if (existing) {
					ref = existing.id;
				} else {
					ref = randomUUID();
					db.prepare(`
						INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
						VALUES (?, ?, ?, ?, ?, 0, ?)
					`).run(ref, acc.provider, `${acc.label} client`, acc.oauth_client_id, acc.oauth_client_secret_encrypted, now);
				}
				db.prepare(`UPDATE accounts SET oauth_client_ref = ? WHERE id = ?`).run(ref, acc.id);
				console.log(`[inbox-migration] Migrated inline OAuth override for account ${acc.id} → oauth_clients.${ref}`);
			}

			// Default-link existing Gmail accounts that have no override and
			// haven't been linked yet.
			if (defaultGmailId) {
				db.prepare(`
					UPDATE accounts
					SET oauth_client_ref = ?
					WHERE provider = 'gmail'
					  AND oauth_client_ref IS NULL
				`).run(defaultGmailId);
			}

			// Drop the legacy ephemeral table.
			db.exec(`DROP TABLE IF EXISTS pending_oauth_clients;`);

			// Drop the legacy inline columns. SQLite 3.35+ supports DROP COLUMN
			// directly; better-sqlite3 ships with SQLite ≥ 3.45.
			db.exec(`
				ALTER TABLE accounts DROP COLUMN oauth_client_id;
				ALTER TABLE accounts DROP COLUMN oauth_client_secret_encrypted;
			`);
		});
		tx();
		db.pragma(`user_version = 5`);
	}
}

// ── Account CRUD ──

export function addAccount(
	account: Pick<InboxAccount, 'id' | 'label' | 'provider' | 'email' | 'host' | 'port'>,
	credential: string,
	oauthClientRef?: string | null,
): InboxAccount {
	const db = getInboxDb();
	const now = Date.now();
	const encrypted = encrypt(credential);

	// New accounts default to 90-day retention. The schema's column default
	// is still 30 from migration #2 (kept untouched to avoid disturbing
	// existing rows). Specifying it explicitly here makes the new-account
	// behavior independent of the schema default.
	db.prepare(`
		INSERT INTO accounts (id, label, provider, email, host, port, encrypted_credential, status, retention_days, oauth_client_ref, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'disconnected', 90, ?, ?)
	`).run(
		account.id,
		account.label,
		account.provider,
		account.email,
		account.host ?? null,
		account.port ?? null,
		encrypted,
		oauthClientRef ?? null,
		now,
	);

	return {
		...account,
		host: account.host,
		port: account.port,
		status: 'disconnected',
		lastSync: null,
		lastError: null,
		createdAt: now,
		retentionDays: 90,
		oauthClientRef: oauthClientRef ?? null,
	};
}

export function getAccount(id: string): InboxAccount | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToAccount(row);
}

export function listAccounts(): InboxAccount[] {
	const db = getInboxDb();
	const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as Record<string, unknown>[];
	return rows.map(rowToAccount);
}

export function removeAccount(id: string): boolean {
	const db = getInboxDb();
	const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
	// Cascade deletes messages + sync_state via FK
	return result.changes > 0;
}

export function updateAccountStatus(id: string, status: AccountStatus, error?: string | null): void {
	const db = getInboxDb();
	db.prepare('UPDATE accounts SET status = ?, last_error = ? WHERE id = ?')
		.run(status, error ?? null, id);
}

export function updateAccountLastSync(id: string): void {
	const db = getInboxDb();
	const now = Date.now();
	db.prepare('UPDATE accounts SET last_sync = ?, status = ? WHERE id = ?')
		.run(now, 'connected', id);
}

export function getAccountCredential(id: string): string | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT encrypted_credential FROM accounts WHERE id = ?').get(id) as { encrypted_credential: string } | undefined;
	if (!row) return null;
	return decrypt(row.encrypted_credential);
}

function rowToAccount(row: Record<string, unknown>): InboxAccount {
	return {
		id: row.id as string,
		label: row.label as string,
		provider: row.provider as InboxProvider,
		email: row.email as string,
		host: row.host as string | undefined,
		port: row.port as number | undefined,
		status: row.status as AccountStatus,
		lastSync: row.last_sync as number | null,
		lastError: row.last_error as string | null,
		createdAt: row.created_at as number,
		retentionDays: (row.retention_days as number) ?? 90,
		oauthClientRef: (row.oauth_client_ref as string | null) ?? null,
	};
}

// ── OAuth Client (Connections) CRUD ──

export function listOauthClients(provider?: InboxProvider): OauthClient[] {
	const db = getInboxDb();
	const rows = provider
		? db.prepare(`SELECT * FROM oauth_clients WHERE provider = ? ORDER BY is_default DESC, created_at`).all(provider)
		: db.prepare(`SELECT * FROM oauth_clients ORDER BY provider, is_default DESC, created_at`).all();
	return (rows as Record<string, unknown>[]).map(rowToOauthClient);
}

export function getOauthClient(id: string): OauthClient | null {
	const db = getInboxDb();
	const row = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToOauthClient(row);
}

export function getDefaultOauthClient(provider: InboxProvider): OauthClient | null {
	const db = getInboxDb();
	const row = db.prepare(
		`SELECT * FROM oauth_clients WHERE provider = ? AND is_default = 1 LIMIT 1`,
	).get(provider) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToOauthClient(row);
}

export function countAccountsUsingOauthClient(clientRef: string): number {
	const db = getInboxDb();
	const row = db.prepare(
		`SELECT COUNT(*) AS c FROM accounts WHERE oauth_client_ref = ?`,
	).get(clientRef) as { c: number };
	return row.c;
}

/**
 * Create a new OAuth client. If `isDefault=true`, any existing default for
 * the same provider is automatically un-defaulted.
 */
export function createOauthClient(input: {
	provider: InboxProvider;
	label: string;
	clientId: string;
	clientSecret: string;
	isDefault?: boolean;
}): OauthClient {
	const db = getInboxDb();
	const now = Date.now();
	const id = randomUUID();
	const isDefault = input.isDefault ? 1 : 0;

	const tx = db.transaction(() => {
		if (isDefault) {
			db.prepare(
				`UPDATE oauth_clients SET is_default = 0 WHERE provider = ? AND is_default = 1`,
			).run(input.provider);
		}
		db.prepare(`
			INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(id, input.provider, input.label, input.clientId, encrypt(input.clientSecret), isDefault, now);
	});
	tx();

	return {
		id,
		provider: input.provider,
		label: input.label,
		clientId: input.clientId,
		clientSecretEncrypted: encrypt(input.clientSecret),
		isDefault: !!input.isDefault,
		createdAt: now,
		lastUsedAt: null,
	};
}

/**
 * Update an OAuth client. `clientId` is immutable — to change the client_id,
 * create a new row. Pass `clientSecret` to rotate the secret. Pass
 * `isDefault=true` to promote; the previous default in the same provider is
 * automatically un-defaulted.
 */
export function updateOauthClient(
	id: string,
	patch: { label?: string; clientSecret?: string; isDefault?: boolean },
): boolean {
	const db = getInboxDb();
	const sets: string[] = [];
	const params: unknown[] = [];

	if (patch.label !== undefined) {
		sets.push('label = ?');
		params.push(patch.label);
	}
	if (patch.clientSecret !== undefined) {
		sets.push('client_secret_encrypted = ?');
		params.push(encrypt(patch.clientSecret));
	}

	const tx = db.transaction(() => {
		if (patch.isDefault === true) {
			const current = db.prepare(`SELECT provider FROM oauth_clients WHERE id = ?`).get(id) as
				| { provider: string }
				| undefined;
			if (current) {
				db.prepare(
					`UPDATE oauth_clients SET is_default = 0 WHERE provider = ? AND is_default = 1`,
				).run(current.provider);
				sets.push('is_default = 1');
			}
		} else if (patch.isDefault === false) {
			sets.push('is_default = 0');
		}

		if (sets.length === 0) return 0;
		params.push(id);
		const result = db.prepare(`UPDATE oauth_clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
		return result.changes;
	});
	return tx() > 0;
}

/**
 * Delete an OAuth client. Refuses if any account references it (returns
 * `{ deleted: false, reason: 'in_use', accountCount }`).
 */
export function deleteOauthClient(id: string): { deleted: boolean; reason?: 'in_use' | 'not_found'; accountCount?: number } {
	const db = getInboxDb();
	const inUse = countAccountsUsingOauthClient(id);
	if (inUse > 0) return { deleted: false, reason: 'in_use', accountCount: inUse };
	const result = db.prepare(`DELETE FROM oauth_clients WHERE id = ?`).run(id);
	if (result.changes === 0) return { deleted: false, reason: 'not_found' };
	return { deleted: true };
}

export function touchOauthClientUsage(id: string): void {
	const db = getInboxDb();
	db.prepare(`UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
}

function rowToOauthClient(row: Record<string, unknown>): OauthClient {
	return {
		id: row.id as string,
		provider: row.provider as InboxProvider,
		label: row.label as string,
		clientId: row.client_id as string,
		clientSecretEncrypted: row.client_secret_encrypted as string,
		isDefault: (row.is_default as number) === 1,
		createdAt: row.created_at as number,
		lastUsedAt: (row.last_used_at as number | null) ?? null,
	};
}

// ── Message CRUD ──

export function upsertMessage(msg: Omit<InboxMessage, 'id'>): number {
	const db = getInboxDb();
	const result = db.prepare(`
		INSERT INTO messages (account_id, uid, uid_validity, folder, message_id, thread_id, in_reply_to,
			subject, from_address, from_name, to_address, date_sent, date_received, flags,
			has_attachments, body_preview, raw_size, content_hash, synced_at,
			process_status, attachments_meta, attachment_count, is_flagged)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, uid, folder, uid_validity) DO UPDATE SET
			flags = excluded.flags,
			is_flagged = excluded.is_flagged,
			synced_at = excluded.synced_at
	`).run(
		msg.accountId, msg.uid, msg.uidValidity, msg.folder,
		msg.messageId, msg.threadId, msg.inReplyTo,
		msg.subject, msg.fromAddress, msg.fromName, msg.toAddress,
		msg.dateSent, msg.dateReceived, JSON.stringify(msg.flags),
		msg.hasAttachments ? 1 : 0, msg.bodyPreview, msg.rawSize,
		null, // content_hash computed later if needed
		msg.syncedAt,
		msg.processStatus || 'new',
		JSON.stringify(msg.attachmentsMeta || []),
		msg.attachmentCount || 0,
		msg.isFlagged ? 1 : 0,
	);
	return Number(result.lastInsertRowid);
}

export function upsertMessages(messages: Omit<InboxMessage, 'id'>[]): void {
	const db = getInboxDb();
	const insert = db.prepare(`
		INSERT INTO messages (account_id, uid, uid_validity, folder, message_id, thread_id, in_reply_to,
			subject, from_address, from_name, to_address, date_sent, date_received, flags,
			has_attachments, body_preview, raw_size, content_hash, synced_at,
			process_status, attachments_meta, attachment_count, is_flagged)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, uid, folder, uid_validity) DO UPDATE SET
			flags = excluded.flags,
			is_flagged = excluded.is_flagged,
			synced_at = excluded.synced_at
	`);

	const tx = db.transaction((msgs: Omit<InboxMessage, 'id'>[]) => {
		for (const msg of msgs) {
			insert.run(
				msg.accountId, msg.uid, msg.uidValidity, msg.folder,
				msg.messageId, msg.threadId, msg.inReplyTo,
				msg.subject, msg.fromAddress, msg.fromName, msg.toAddress,
				msg.dateSent, msg.dateReceived, JSON.stringify(msg.flags),
				msg.hasAttachments ? 1 : 0, msg.bodyPreview, msg.rawSize,
				null, msg.syncedAt,
				msg.processStatus || 'new',
				JSON.stringify(msg.attachmentsMeta || []),
				msg.attachmentCount || 0,
				msg.isFlagged ? 1 : 0,
			);
		}
	});

	tx(messages);
}

export interface MessageListOptions {
	accountId?: string;
	folder?: string;
	limit?: number;
	offset?: number;
	search?: string;
	status?: string;
}

export function listMessages(opts: MessageListOptions = {}): { messages: InboxMessage[]; total: number } {
	const db = getInboxDb();
	const limit = opts.limit ?? 50;
	const offset = opts.offset ?? 0;

	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.accountId) {
		conditions.push('m.account_id = ?');
		params.push(opts.accountId);
	}
	if (opts.folder) {
		conditions.push('m.folder = ?');
		params.push(opts.folder);
	}
	if (opts.status) {
		conditions.push('m.process_status = ?');
		params.push(opts.status);
	}

	let query: string;
	let countQuery: string;

	if (opts.search) {
		// FTS5 search
		query = `
			SELECT m.* FROM messages m
			INNER JOIN messages_fts fts ON fts.rowid = m.id
			WHERE messages_fts MATCH ?
			${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
			ORDER BY COALESCE(m.date_sent, m.date_received) DESC
			LIMIT ? OFFSET ?
		`;
		countQuery = `
			SELECT COUNT(*) as total FROM messages m
			INNER JOIN messages_fts fts ON fts.rowid = m.id
			WHERE messages_fts MATCH ?
			${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
		`;
		params.unshift(opts.search);
	} else {
		const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
		query = `
			SELECT m.* FROM messages m ${where}
			ORDER BY COALESCE(m.date_sent, m.date_received) DESC
			LIMIT ? OFFSET ?
		`;
		countQuery = `SELECT COUNT(*) as total FROM messages m ${where}`;
	}

	const rows = db.prepare(query).all(...params, limit, offset) as Record<string, unknown>[];
	const { total } = db.prepare(countQuery).get(...params) as { total: number };

	return {
		messages: rows.map(rowToMessage),
		total,
	};
}

export function getMessage(id: number): InboxMessage | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToMessage(row);
}

export function getMessageCount(accountId?: string): number {
	const db = getInboxDb();
	if (accountId) {
		const row = db.prepare('SELECT COUNT(*) as c FROM messages WHERE account_id = ?').get(accountId) as { c: number };
		return row.c;
	}
	const row = db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number };
	return row.c;
}

function rowToMessage(row: Record<string, unknown>): InboxMessage {
	return {
		id: row.id as number,
		accountId: row.account_id as string,
		uid: row.uid as number,
		uidValidity: row.uid_validity as number,
		folder: row.folder as string,
		messageId: row.message_id as string | null,
		threadId: row.thread_id as string | null,
		inReplyTo: row.in_reply_to as string | null,
		subject: row.subject as string,
		fromAddress: row.from_address as string,
		fromName: row.from_name as string | null,
		toAddress: row.to_address as string,
		dateSent: row.date_sent as number | null,
		dateReceived: row.date_received as number,
		flags: JSON.parse((row.flags as string) || '[]'),
		hasAttachments: (row.has_attachments as number) === 1,
		bodyPreview: row.body_preview as string,
		rawSize: row.raw_size as number,
		syncedAt: row.synced_at as number,
		processStatus: (row.process_status as string) || 'new',
		attachmentsMeta: JSON.parse((row.attachments_meta as string) || '[]'),
		attachmentCount: (row.attachment_count as number) || 0,
		isFlagged: (row.is_flagged as number) === 1,
	};
}

// ── Sync State ──

export function getSyncState(accountId: string, folder: string): SyncState | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM sync_state WHERE account_id = ? AND folder = ?')
		.get(accountId, folder) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		accountId: row.account_id as string,
		folder: row.folder as string,
		lastUid: row.last_uid as number,
		uidValidity: row.uid_validity as number,
		lastSync: row.last_sync as number,
	};
}

export function upsertSyncState(state: SyncState): void {
	const db = getInboxDb();
	db.prepare(`
		INSERT INTO sync_state (account_id, folder, last_uid, uid_validity, last_sync)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(account_id, folder) DO UPDATE SET
			last_uid = excluded.last_uid,
			uid_validity = excluded.uid_validity,
			last_sync = excluded.last_sync
	`).run(state.accountId, state.folder, state.lastUid, state.uidValidity, state.lastSync);
}

// ── Stats ──

/**
 * Delete all messages for (account, folder), optionally filtered to a specific
 * `uid_validity`. Used by the sync worker when the server reports a UIDVALIDITY
 * change — the old uid <-> message mapping is invalid and the existing rows
 * would otherwise show up in the inbox UI as orphans.
 */
export function deleteMessagesByFolder(
	accountId: string,
	folder: string,
	uidValidity?: number,
): number {
	const db = getInboxDb();
	let sql = 'DELETE FROM messages WHERE account_id = ? AND folder = ?';
	const params: (string | number)[] = [accountId, folder];
	if (uidValidity !== undefined) {
		sql += ' AND uid_validity = ?';
		params.push(uidValidity);
	}
	const result = db.prepare(sql).run(...params);
	if (result.changes > 0) {
		console.log(
			`[inbox:${accountId}] Deleted ${result.changes} messages from ${folder}` +
				(uidValidity !== undefined ? ` (uid_validity=${uidValidity})` : ''),
		);
	}
	return result.changes;
}

export function pruneOldMessages(accountId: string, retentionDays: number): number {
	const db = getInboxDb();
	if (retentionDays <= 0) return 0;

	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = db.prepare(`
		DELETE FROM messages
		WHERE account_id = ?
		  AND date_received < ?
		  AND process_status IN ('new', 'skipped')
		  AND is_flagged = 0
	`).run(accountId, cutoffMs);

	if (result.changes > 0) {
		console.log(`[inbox-prune:${accountId}] Pruned ${result.changes} messages older than ${retentionDays} days`);
	}
	return result.changes;
}

export function updateAccountSettings(
	id: string,
	settings: { label?: string; retentionDays?: number; oauthClientRef?: string | null },
): boolean {
	const db = getInboxDb();
	const sets: string[] = [];
	const params: unknown[] = [];

	if (settings.label !== undefined) {
		sets.push('label = ?');
		params.push(settings.label);
	}
	// retentionDays = 0 is the "never delete" sentinel — pruneOldMessages
	// already short-circuits on retentionDays <= 0. Accept 0..365.
	if (
		settings.retentionDays !== undefined &&
		settings.retentionDays >= 0 &&
		settings.retentionDays <= 365
	) {
		sets.push('retention_days = ?');
		params.push(settings.retentionDays);
	}
	if (settings.oauthClientRef !== undefined) {
		sets.push('oauth_client_ref = ?');
		params.push(settings.oauthClientRef);
	}
	if (sets.length === 0) return false;

	params.push(id);
	const result = db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
	return result.changes > 0;
}

export function updateAccountCredential(id: string, credential: string): boolean {
	const db = getInboxDb();
	const encrypted = encrypt(credential);
	const result = db.prepare(`
		UPDATE accounts
		SET encrypted_credential = ?, status = 'disconnected', last_error = NULL
		WHERE id = ?
	`).run(encrypted, id);
	return result.changes > 0;
}

export function getInboxStats(): { accounts: number; messages: number; lastSync: number | null } {
	const db = getInboxDb();
	const accounts = (db.prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number }).c;
	const messages = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
	const lastSync = (db.prepare('SELECT MAX(last_sync) as ls FROM accounts').get() as { ls: number | null }).ls;
	return { accounts, messages, lastSync };
}
