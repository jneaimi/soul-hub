/**
 * Edge-triggered Telegram notifications for inbox sync health.
 *
 * Wraps `updateAccountStatus` / `updateAccountLastSync` so the notification
 * decision lives next to the state transition that causes it.
 *
 * Strategy:
 *   - Failure: notify the FIRST time an account enters error state. Subsequent
 *     errors are silent until the account recovers. Prevents notification
 *     storms during a flaky-network reconnect loop (cf. the 2026-05-10
 *     reconnect-storm cascade, where the issue was undetected for 7 days
 *     because nobody was looking at the inbox UI).
 *   - Recovery: notify the FIRST time an account transitions back to
 *     connected after we previously alerted on it. Paired with the failure
 *     alert — each "outage incident" produces exactly two messages.
 *
 * Best-effort: Telegram failures log a warning and do nothing else. Sync
 * worker availability is more important than any single notification.
 *
 * State lives in memory: a PM2 restart wipes the alerted set, which is the
 * right behavior — operator should be re-alerted on restart if the issue
 * is still active.
 */

import { send as sendTelegram } from '../channels/telegram/index.js';
import { updateAccountStatus, updateAccountLastSync } from './db.js';
import type { InboxAccount } from './types.js';

const alertedAccounts = new Set<string>();

export function markAccountFailed(account: InboxAccount, error: string): void {
	updateAccountStatus(account.id, 'error', error);
	void notifyAccountFailure(account, error);
}

export function markAccountRecovered(account: InboxAccount): void {
	updateAccountLastSync(account.id);
	if (alertedAccounts.has(account.id)) {
		alertedAccounts.delete(account.id);
		void notifyAccountRecovered(account);
	}
}

/** Drop tracking state for a removed account — prevents the in-memory Set
 *  from growing unboundedly as accounts are added and removed over time. */
export function clearAccountAlert(accountId: string): void {
	alertedAccounts.delete(accountId);
}

async function notifyAccountFailure(account: InboxAccount, error: string): Promise<void> {
	if (alertedAccounts.has(account.id)) return;
	alertedAccounts.add(account.id);

	const text = [
		`🔴 *Inbox sync failed* — ${account.label}`,
		`\`${account.email}\` (${account.provider})`,
		``,
		`*Error:* ${truncate(error, 200)}`,
		``,
		`Open the inbox UI to Reset password or Reauthorize.`,
	].join('\n');

	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(`[inbox-notify] telegram send failed for ${account.id}: ${result.error}`);
		}
	} catch (err) {
		console.warn(`[inbox-notify] telegram send threw for ${account.id}: ${(err as Error).message}`);
	}
}

async function notifyAccountRecovered(account: InboxAccount): Promise<void> {
	const text = [
		`🟢 *Inbox sync recovered* — ${account.label}`,
		`\`${account.email}\` (${account.provider})`,
	].join('\n');

	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(`[inbox-notify] telegram send failed for ${account.id}: ${result.error}`);
		}
	} catch (err) {
		console.warn(`[inbox-notify] telegram send threw for ${account.id}: ${(err as Error).message}`);
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
