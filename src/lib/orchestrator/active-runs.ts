/**
 * In-process per-JID active-run registry.
 *
 * The agents module's `agent_runs` table only records terminal rows, so
 * "is anything running for this JID right now" can't be answered from
 * SQL. This Map fills that gap. Reset on PM2 restart by design — see
 * WhatsApp ADR-005 §Database for why we don't persist mid-run state.
 */

export interface ActiveRun {
	runId: string;
	agentId: string;
	startedAt: number;
	abortController: AbortController;
}

const active = new Map<string, ActiveRun>();

export function getActiveByJid(jid: string): ActiveRun | undefined {
	return active.get(jid);
}

export function setActive(jid: string, run: ActiveRun): void {
	active.set(jid, run);
}

export function clearActive(jid: string): void {
	active.delete(jid);
}

/** Cancel any active run for the given JID. Returns the run that was
 *  cancelled, or null if nothing was running. */
export function cancelByJid(jid: string): ActiveRun | null {
	const run = active.get(jid);
	if (!run) return null;
	run.abortController.abort();
	active.delete(jid);
	return run;
}

/** Snapshot for diagnostics. */
export function listActive(): ActiveRun[] {
	return Array.from(active.values());
}
