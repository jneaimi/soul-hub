/** CRM module — public API. See ADR 2026-05-11-crm-local-sqlite-transition. */

export {
	getCrmDb, closeCrmDb,
	addContact, getContact, listContacts, searchContacts,
	updateContactStage, setNextFollowup, deleteContact,
	addContactEmail, setPrimaryEmail, listContactEmails, findContactByEmail,
	addInteraction, listInteractions,
	addTag, tagContact, listContactTags,
	listStageHistory, listFollowups,
	type ListContactsOptions, type AddContactEmailInput, type AddInteractionInput,
	type ListFollowupsOptions,
} from './db.js';

export type {
	Contact, ContactEmail, ContactEmailMatch, ContactWithEmails,
	Interaction, StageHistory, Tag,
	ContactStage, ContactSource,
	InteractionChannel, InteractionDirection,
	NewContactInput,
} from './types.js';
export { CONTACT_STAGES } from './types.js';

// Stage B — cross-DB bridge.
export {
	listMessagesForContact,
	enrichInboxRowsWithContact,
	findWebsiteLeads,
	isCrmContact,
	type ListMessagesForContactOptions,
	type InboxRowEnrichment,
	type WebsiteLeadsOptions,
	type WebsiteLeadCandidate,
} from './inbox-bridge.js';

// Stage B — vault frontmatter sync.
export {
	syncContactToVault,
	defaultContactPath,
	type SyncContactResult,
} from './vault-sync.js';
