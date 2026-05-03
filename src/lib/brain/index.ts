/** Brain barrel — public surface for the WhatsApp `/save`, `/find`,
 *  `/recent` slash commands. Mirrors the `vault-chat/index.ts` shape so
 *  the dispatcher imports stay consistent across intents. */

export { dispatchBrainSave } from './save.js';
export type { BrainSaveInput, BrainSaveResult } from './save.js';
export { dispatchBrainFind } from './find.js';
export type { BrainFindResult } from './find.js';
export { dispatchBrainRecent } from './recent.js';
export type { BrainRecentResult } from './recent.js';
