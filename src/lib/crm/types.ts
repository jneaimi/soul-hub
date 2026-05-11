/**
 * CRM types — mirror of the SQLite schema in db.ts migration #1.
 *
 * Designed per ADR 2026-05-11-crm-local-sqlite-transition. See D2 for the
 * canonical schema. These TypeScript interfaces are the boundary contract
 * between db.ts (SQL) and the rest of Soul Hub (tools, API, UI). All
 * timestamps are epoch ms (Date.now()). All IDs are stable across rename.
 */

/** Pipeline stages per ADR D2 — kept identical to the original SKILL.md
 *  design so operator-facing semantics don't shift. */
export type ContactStage =
	| 'Lead'
	| 'Contacted'
	| 'In Conversation'
	| 'Proposal'
	| 'Won'
	| 'Lost';

export const CONTACT_STAGES: readonly ContactStage[] = [
	'Lead',
	'Contacted',
	'In Conversation',
	'Proposal',
	'Won',
	'Lost',
] as const;

/** Sources used during contact creation. NULL is allowed when source is
 *  unknown or operator skips it. */
export type ContactSource =
	| 'Website'
	| 'LinkedIn'
	| 'Twitter'
	| 'Email'
	| 'Referral'
	| 'Speaking';

/** Interaction direction — inbound (they reached out) or outbound (we did). */
export type InteractionDirection = 'inbound' | 'outbound';

/** Channel of an interaction. Strings rather than enum because future
 *  channels (e.g. 'telegram', 'voice') should land without a migration. */
export type InteractionChannel =
	| 'email'
	| 'call'
	| 'meeting'
	| 'social'
	| 'whatsapp'
	| 'other';

export interface Contact {
	id: string;                 // 'CRM-YYYY-NNN'
	displayName: string;
	company: string | null;
	role: string | null;
	source: ContactSource | null;
	stage: ContactStage;
	dealType: string | null;    // 'consulting' | 'speaking' | 'collaboration' | etc.
	dealValue: number | null;
	dealCurrency: string | null;
	notes: string | null;
	vaultNotePath: string | null;
	nextFollowupAt: number | null;
	lastInteractionAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ContactEmail {
	contactId: string;
	email: string;
	label: string | null;       // 'work' | 'personal' | NULL
	isPrimary: boolean;
	createdAt: number;
}

export interface Interaction {
	id: number;
	contactId: string;
	timestamp: number;          // when it happened (operator's value, not when logged)
	channel: InteractionChannel;
	direction: InteractionDirection;
	summary: string;
	messageId: number | null;   // cross-DB ref to inbox messages.id; no FK enforced
	createdAt: number;
}

export interface StageHistory {
	id: number;
	contactId: string;
	fromStage: ContactStage;
	toStage: ContactStage;
	movedAt: number;
	reason: string | null;
}

export interface Tag {
	id: number;
	name: string;
}

/** Input shape for addContact. ID is generated server-side from
 *  CRM-YYYY-NNN; emails go through addContactEmail under the same tx. */
export interface NewContactInput {
	displayName: string;
	company?: string | null;
	role?: string | null;
	source?: ContactSource | null;
	stage?: ContactStage;
	dealType?: string | null;
	dealValue?: number | null;
	dealCurrency?: string | null;
	notes?: string | null;
	vaultNotePath?: string | null;
	emails?: Array<{ email: string; label?: string | null; isPrimary?: boolean }>;
}

/** Result shape for addContact — returns the full contact + the persisted
 *  email rows so callers don't need a follow-up SELECT. */
export interface ContactWithEmails extends Contact {
	emails: ContactEmail[];
}

/** Result for findContactByEmail and similar lookups that need both the
 *  contact and the matched email row in one shot. */
export interface ContactEmailMatch {
	contact: Contact;
	matchedEmail: ContactEmail;
}
