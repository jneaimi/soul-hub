/** CRM module — public API. See ADR 2026-05-11-crm-local-sqlite-transition. */

export {
	getCrmDb, closeCrmDb,
	addContact, getContact, listContacts, searchContacts,
	updateContactStage, setNextFollowup, deleteContact,
	addContactEmail, setPrimaryEmail, listContactEmails, findContactByEmail,
	addInteraction, listInteractions,
	addTag, tagContact, listContactTags,
	listStageHistory,
	type ListContactsOptions, type AddContactEmailInput, type AddInteractionInput,
} from './db.js';

export type {
	Contact, ContactEmail, ContactEmailMatch, ContactWithEmails,
	Interaction, StageHistory, Tag,
	ContactStage, ContactSource,
	InteractionChannel, InteractionDirection,
	NewContactInput,
} from './types.js';
export { CONTACT_STAGES } from './types.js';
