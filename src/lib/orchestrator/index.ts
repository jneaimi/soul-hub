/**
 * Orchestrator public surface — the WhatsApp inbound handler imports
 * from here. See WhatsApp ADR-005.
 */

export { decide } from './decide.js';
export type { DecideOptions } from './decide.js';
export { runInBackground } from './worker.js';
export type { RunInBackgroundArgs } from './worker.js';
export {
	getActiveByJid,
	setActive,
	clearActive,
	cancelByJid,
	listActive,
} from './active-runs.js';
export type { ActiveRun } from './active-runs.js';
export type { OrchestratorAction, OrchestratorDecision, DecideResult } from './types.js';
export { getOrchestratorMetrics } from './metrics.js';
export type { OrchestratorMetrics } from './metrics.js';
