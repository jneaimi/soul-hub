/** Shared shape for the vault hygiene report. Consumed by the API
 *  endpoint, the heartbeat hook, and (read-only) by the keeper agent
 *  prompt. The shape is contract-stable; new fields go on the end so
 *  older keeper prompts continue to parse. */

export interface HygieneTotals {
	indexed: number;
	orphans: number;
	unresolved: number;
	staleInbox: number;
	statusContradictions: number;
	governanceViolations: number;
}

export interface OrphanIssue {
	path: string;
	title: string;
	suggestedFix: string;
}

export interface UnresolvedIssue {
	source: string;
	raw: string;
	suggestedFix: string;
}

export interface StaleInboxIssue {
	path: string;
	title: string;
	ageDays: number;
	suggestedFix: string;
}

export interface StatusContradictionIssue {
	path: string;
	status: string;
	openTaskCount: number;
	suggestedFix: string;
}

export interface GovernanceViolationIssue {
	path: string;
	violations: string[];
}

export interface HygieneReport {
	generatedAt: string;
	totals: HygieneTotals;
	healthScore: number;
	orphans: OrphanIssue[];
	unresolved: UnresolvedIssue[];
	staleInbox: StaleInboxIssue[];
	statusContradictions: StatusContradictionIssue[];
	governanceViolations: GovernanceViolationIssue[];
}

/** Heartbeat dispatch threshold — defaults match ADR-010 open Q2.
 *  Tunable in Phase D after live observation. */
export interface HygieneThreshold {
	orphansPlusContradictions: number;
	staleInbox: number;
	governanceViolations: number;
}

export const DEFAULT_HYGIENE_THRESHOLD: HygieneThreshold = {
	orphansPlusContradictions: 1,
	staleInbox: 5,
	governanceViolations: 10,
};

/** Cap noisy issue lists in the dispatch payload — keeper doesn't need
 *  to see all 458 stale items; the first N are enough to triage and the
 *  totals are still accurate. */
export const ISSUE_LIST_CAP = 20;
