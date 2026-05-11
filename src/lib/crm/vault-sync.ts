/**
 * One-way DB → markdown frontmatter sync for CRM contacts.
 * (ADR 2026-05-11-crm-local-sqlite-transition §D3 + impl step 5.)
 *
 * The DB is canonical for structured fields (stage, deal_*, follow-up
 * dates, tags). The vault note is canonical for prose. This module is
 * the one-way bridge: every CRM write that changes a managed field can
 * call `syncContactToVault(contactId)` to push the updated frontmatter
 * into the operator's vault note without touching the prose body.
 *
 * Frontmatter contract (managed keys — these MAY be overwritten):
 *   type, created, tags          ← required by GLOBAL_REQUIRED_FIELDS
 *   crm_id, stage, company       ← always written
 *   emails: [{email, label, primary}]
 *   last_synced                  ← ISO timestamp; refreshed every sync
 *
 * Operator-edited frontmatter keys outside this set are preserved by the
 * vault engine's merge semantics (updateNote merges meta over existing).
 * Prose body is preserved by passing `content: undefined` to updateNote
 * (it falls back to `existing.content`).
 *
 * Reverse direction (markdown → DB) is explicitly NOT supported here.
 * Operator edits to frontmatter `tags`, `stage`, etc. are NOT propagated
 * back; the next DB write overwrites them. Documented in ADR §D3.
 */

import {
	getContact,
	listContactEmails,
	listContactTags,
	getCrmDb,
} from './db.js';
import { getVaultEngine } from '../vault/index.js';
import type { Contact, ContactEmail, Tag } from './types.js';

/** Zone under the vault root that holds CRM contact notes. */
const CRM_CONTACTS_ZONE = 'knowledge/crm/contacts';

export interface SyncContactResult {
	ok: boolean;
	/** Vault-relative path of the synced note. Present on success. */
	path?: string;
	/** What actually happened on disk. */
	action?: 'created' | 'updated';
	/** Populated when `ok === false`. */
	error?: string;
}

/**
 * Sync a CRM contact's managed state into its vault note.
 *
 * If the contact has no `vault_note_path` set, derive one from the
 * display-name slug and either create the note (when the file doesn't
 * exist) or attach to the existing one. Either way, the DB row's
 * `vault_note_path` is updated so subsequent syncs are stable.
 *
 * Returns ok=true even when the contact has nothing to write yet
 * (e.g., the operator deleted the contact between read and sync). All
 * vault engine failures bubble up as `{ ok: false, error }`.
 */
export async function syncContactToVault(contactId: string): Promise<SyncContactResult> {
	const contact = getContact(contactId);
	if (!contact) {
		return { ok: false, error: `Contact ${contactId} not found` };
	}

	const vault = getVaultEngine();
	if (!vault) {
		return { ok: false, error: 'Vault engine not initialized' };
	}

	const emails = listContactEmails(contactId);
	const tags = listContactTags(contactId);
	const targetPath = contact.vaultNotePath ?? defaultContactPath(contact.displayName);

	const managedMeta = buildManagedFrontmatter(contact, emails, tags);
	const existing = vault.getNote(targetPath);

	if (existing) {
		const result = await vault.updateNote(targetPath, { meta: managedMeta });
		if (!result.success) return { ok: false, error: result.error };
		await persistVaultPath(contactId, result.path);
		return { ok: true, path: result.path, action: 'updated' };
	}

	const result = await vault.createNote({
		zone: CRM_CONTACTS_ZONE,
		filename: targetPath.split('/').pop() ?? `${slugifyName(contact.displayName)}.md`,
		meta: managedMeta,
		content: buildScaffoldContent(contact),
	});
	if (!result.success) return { ok: false, error: result.error };
	await persistVaultPath(contactId, result.path);
	return { ok: true, path: result.path, action: 'created' };
}

/** Default vault-relative path for a contact. The slug matches the
 *  vault-save brain convention so paths are stable across rename. */
export function defaultContactPath(displayName: string): string {
	return `${CRM_CONTACTS_ZONE}/${slugifyName(displayName)}.md`;
}

// ─── internals ─────────────────────────────────────────────────────────────

function buildManagedFrontmatter(
	contact: Contact,
	emails: ContactEmail[],
	tags: Tag[],
): Record<string, unknown> {
	const now = new Date();
	return {
		// GLOBAL_REQUIRED_FIELDS — always present on every vault note.
		type: 'contact',
		created: contact.createdAt
			? new Date(contact.createdAt).toISOString().slice(0, 10)
			: now.toISOString().slice(0, 10),
		tags: tags.map((t) => t.name),
		// CRM-managed keys.
		crm_id: contact.id,
		stage: contact.stage,
		company: contact.company ?? undefined,
		role: contact.role ?? undefined,
		emails: emails.map((e) => ({
			email: e.email,
			label: e.label ?? undefined,
			primary: e.isPrimary,
		})),
		last_synced: now.toISOString(),
	};
}

function buildScaffoldContent(contact: Contact): string {
	// Minimal body — the Stage F template (impl step 19) will replace this
	// with the canonical layout. Until then, a heading + a context line lets
	// the operator start writing prose immediately.
	const company = contact.company ? ` — ${contact.company}` : '';
	return `# ${contact.displayName}${company}\n\n*Prose notes go here. Stage / emails / tags live in frontmatter and are DB-canonical.*\n`;
}

/** Slug a display name into a kebab-case filename stem. Mirrors
 *  vault-save/index.ts:slugify so paths sort consistently across surfaces. */
function slugifyName(input: string): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const truncated = normalized.slice(0, 60).replace(/-+$/, '');
	return truncated || 'contact';
}

/** Persist the resolved vault path back to the contact row so subsequent
 *  syncs target the same file. Idempotent — no-op when path is unchanged. */
async function persistVaultPath(contactId: string, vaultPath: string): Promise<void> {
	const db = getCrmDb();
	db.prepare(`
		UPDATE contacts
		SET vault_note_path = ?, updated_at = ?
		WHERE id = ? AND (vault_note_path IS NULL OR vault_note_path != ?)
	`).run(vaultPath, Date.now(), contactId, vaultPath);
}
