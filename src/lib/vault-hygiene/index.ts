export { getHygieneReport } from './report.js';
export { tickVaultHygiene, _resetHygieneTickState } from './heartbeat-tick.js';
export { computeHealthScore } from './health-score.js';
export { getStaleInbox } from './stale-inbox.js';
export { getStatusContradictions } from './status-contradictions.js';
export type {
	HygieneReport,
	HygieneTotals,
	HygieneThreshold,
	OrphanIssue,
	UnresolvedIssue,
	StaleInboxIssue,
	StatusContradictionIssue,
	GovernanceViolationIssue,
} from './types.js';
export type { HygieneTickResult } from './heartbeat-tick.js';
export { DEFAULT_HYGIENE_THRESHOLD } from './types.js';
