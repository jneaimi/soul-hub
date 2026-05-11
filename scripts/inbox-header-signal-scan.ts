/**
 * One-shot Layer 2 design data-grounding scan (2026-05-11).
 *
 * Picks N random Gmail messages from the inbox cache, re-fetches RFC822
 * headers via IMAP, and reports the distribution of classification signal
 * markers. Output grounds the Layer 2 design session — see
 * 2026-05-11-inbox-processing-filter-layer.md.
 *
 * Run:  npx tsx scripts/inbox-header-signal-scan.ts [accountId] [sampleSize]
 *
 * Defaults: accountId=first Gmail account, sampleSize=200.
 *
 * Outputs counts + percentages for each signal:
 *   - List-Unsubscribe / List-Unsubscribe-Post
 *   - List-ID
 *   - Precedence: bulk/list/junk
 *   - Auto-Submitted: not "no"
 *   - From: matches noreply/do-not-reply
 *   - From: matches marketing-domain regex
 *   - Authentication-Results: DMARC pass + From-domain match
 *   - Any-signal vs no-signal (the gray-area count)
 */

import { ImapFlow } from 'imapflow';
import {
	getInboxDb,
	listAccounts,
	getAccountCredential,
	encrypt,
	resolveClientCredsForAccount,
} from '../src/lib/inbox/index.js';
import { getValidToken } from '../src/lib/inbox/oauth.js';

const SAMPLE_SIZE = Number(process.argv[3]) || 200;

const MARKETING_DOMAINS = [
	'mailgun', 'sendgrid', 'klaviyo', 'hubspot', 'mailchimp', 'mailerlite',
	'substack', 'beehiiv', 'convertkit', 'aweber', 'constantcontact',
	'campaignmonitor', 'getresponse', 'sparkpostmail', 'amazonses',
	'rsgsv.net', 'mcsv.net', 'cmail19.com', 'icloud.com',
];

interface Counts {
	listUnsubscribe: number;
	listId: number;
	precedenceBulk: number;
	autoSubmitted: number;
	fromNoReply: number;
	fromMarketingDomain: number;
	authResultsDmarcPass: number;
	icsAttachment: number;
	anySignal: number;
	noSignal: number;
	fetchErrors: number;
}

interface ExampleRow {
	uid: number;
	from: string;
	subject: string;
	signals: string[];
}

function pickAccount(): string {
	const accounts = listAccounts();
	const gmail = accounts.find((a) => a.provider === 'gmail');
	if (!gmail) throw new Error('No Gmail account in inbox.db');
	if (process.argv[2]) {
		const acc = accounts.find((a) => a.id === process.argv[2]);
		if (!acc) throw new Error(`Account ${process.argv[2]} not found`);
		return acc.id;
	}
	return gmail.id;
}

async function connectImap(accountId: string): Promise<ImapFlow> {
	const accounts = listAccounts();
	const account = accounts.find((a) => a.id === accountId);
	if (!account) throw new Error(`Account ${accountId} not found`);

	const credential = getAccountCredential(account.id);
	if (!credential) throw new Error('No credential');

	let parsedCred: { type?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | null = null;
	try { parsedCred = JSON.parse(credential); } catch { /* plain pwd */ }

	const cfg: Record<string, unknown> = {
		host: account.host || 'imap.gmail.com',
		port: account.port || 993,
		secure: true,
		logger: false,
		tls: { rejectUnauthorized: true },
	};

	if (parsedCred?.type === 'oauth2' && parsedCred.refreshToken) {
		const tokens = await getValidToken(
			{
				accessToken: parsedCred.accessToken || '',
				refreshToken: parsedCred.refreshToken,
				expiresAt: parsedCred.expiresAt || 0,
			},
			resolveClientCredsForAccount(account),
		);
		if (tokens.accessToken !== parsedCred.accessToken) {
			const updatedCred = JSON.stringify({
				type: 'oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});
			getInboxDb().prepare('UPDATE accounts SET encrypted_credential = ? WHERE id = ?')
				.run(encrypt(updatedCred), account.id);
		}
		cfg.auth = { user: account.email, accessToken: tokens.accessToken };
	} else {
		cfg.auth = { user: account.email, pass: credential };
	}

	const client = new ImapFlow(cfg as unknown as ConstructorParameters<typeof ImapFlow>[0]);
	await client.connect();
	return client;
}

function pickSampleUids(accountId: string, n: number): number[] {
	const db = getInboxDb();
	const rows = db.prepare(`
		SELECT uid FROM messages
		WHERE account_id = ? AND folder = 'INBOX'
		ORDER BY RANDOM()
		LIMIT ?
	`).all(accountId, n) as { uid: number }[];
	return rows.map((r) => r.uid);
}

function getHeader(headers: string, name: string): string | null {
	// imapflow returns headers as a single \r\n-delimited string. RFC 5322
	// allows folded headers (continuation lines start with whitespace).
	const lc = name.toLowerCase();
	const lines = headers.split(/\r?\n/);
	const collected: string[] = [];
	let inMatch = false;
	for (const line of lines) {
		if (inMatch && /^\s/.test(line)) {
			collected[collected.length - 1] += ' ' + line.trim();
			continue;
		}
		inMatch = false;
		const m = line.match(/^([^:]+):\s*(.*)$/);
		if (m && m[1].toLowerCase() === lc) {
			collected.push(m[2]);
			inMatch = true;
		}
	}
	return collected.length > 0 ? collected.join(' / ') : null;
}

function classifySignals(headers: string): { signals: string[]; isMarketing: boolean } {
	const signals: string[] = [];
	const has = (name: string) => getHeader(headers, name) !== null;
	const headerValue = (name: string) => (getHeader(headers, name) || '').toLowerCase();

	if (has('List-Unsubscribe') || has('List-Unsubscribe-Post')) signals.push('list-unsubscribe');
	if (has('List-ID')) signals.push('list-id');
	const prec = headerValue('Precedence');
	if (prec === 'bulk' || prec === 'list' || prec === 'junk') signals.push(`precedence:${prec}`);
	const auto = headerValue('Auto-Submitted');
	if (auto && auto !== 'no') signals.push('auto-submitted');

	const from = headerValue('From');
	if (/no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply/.test(from)) signals.push('from:noreply');

	for (const d of MARKETING_DOMAINS) {
		if (from.includes(d)) {
			signals.push(`from:${d}`);
			break;
		}
	}

	const authRes = headerValue('Authentication-Results');
	if (authRes && /dmarc=pass/.test(authRes)) signals.push('dmarc-pass');

	const ct = headerValue('Content-Type');
	if (ct.includes('text/calendar') || ct.includes('.ics')) signals.push('ics');

	const isMarketing = signals.some((s) =>
		s === 'list-unsubscribe' || s === 'list-id' || s.startsWith('precedence:') ||
		s === 'auto-submitted' || s.startsWith('from:') && s !== 'dmarc-pass',
	);

	return { signals, isMarketing };
}

async function main() {
	const accountId = pickAccount();
	console.log(`[scan] account=${accountId}, sample=${SAMPLE_SIZE}`);

	const uids = pickSampleUids(accountId, SAMPLE_SIZE);
	console.log(`[scan] picked ${uids.length} uids from cache`);

	const counts: Counts = {
		listUnsubscribe: 0, listId: 0, precedenceBulk: 0, autoSubmitted: 0,
		fromNoReply: 0, fromMarketingDomain: 0, authResultsDmarcPass: 0, icsAttachment: 0,
		anySignal: 0, noSignal: 0, fetchErrors: 0,
	};
	const grayArea: ExampleRow[] = [];
	const strongMarketing: ExampleRow[] = [];

	const client = await connectImap(accountId);
	const t0 = Date.now();

	try {
		await client.mailboxOpen('INBOX', { readOnly: true });

		let i = 0;
		for (const uid of uids) {
			i += 1;
			if (i % 25 === 0) console.log(`[scan] ${i}/${uids.length}…`);
			try {
				const msg = await client.fetchOne(
					uid.toString(),
					{ headers: true, envelope: true },
					{ uid: true },
				);
				if (!msg || !msg.headers) {
					counts.fetchErrors += 1;
					continue;
				}
				const headers = msg.headers.toString();
				const { signals, isMarketing } = classifySignals(headers);

				if (signals.includes('list-unsubscribe')) counts.listUnsubscribe += 1;
				if (signals.includes('list-id')) counts.listId += 1;
				if (signals.some((s) => s.startsWith('precedence:'))) counts.precedenceBulk += 1;
				if (signals.includes('auto-submitted')) counts.autoSubmitted += 1;
				if (signals.includes('from:noreply')) counts.fromNoReply += 1;
				if (signals.some((s) => s.startsWith('from:') && s !== 'from:noreply')) counts.fromMarketingDomain += 1;
				if (signals.includes('dmarc-pass')) counts.authResultsDmarcPass += 1;
				if (signals.includes('ics')) counts.icsAttachment += 1;

				if (isMarketing) {
					counts.anySignal += 1;
					if (strongMarketing.length < 5) {
						strongMarketing.push({
							uid,
							from: msg.envelope?.from?.[0]?.address || '?',
							subject: msg.envelope?.subject || '',
							signals,
						});
					}
				} else {
					counts.noSignal += 1;
					if (grayArea.length < 10) {
						grayArea.push({
							uid,
							from: msg.envelope?.from?.[0]?.address || '?',
							subject: msg.envelope?.subject || '',
							signals,
						});
					}
				}
			} catch (err) {
				counts.fetchErrors += 1;
				if (counts.fetchErrors < 3) {
					console.error(`[scan] uid=${uid} failed:`, err instanceof Error ? err.message : err);
				}
			}
		}
	} finally {
		await client.logout();
	}

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	const total = uids.length - counts.fetchErrors;
	const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—';

	console.log('');
	console.log('═══════════════════════════════════════════════════════');
	console.log(`Layer 2 header-signal scan — ${total} messages, ${elapsed}s`);
	console.log('═══════════════════════════════════════════════════════');
	console.log('');
	console.log('Per-signal coverage (overlapping, not exclusive):');
	console.log(`  List-Unsubscribe        ${pct(counts.listUnsubscribe).padStart(7)}  ${counts.listUnsubscribe}/${total}`);
	console.log(`  List-ID                 ${pct(counts.listId).padStart(7)}  ${counts.listId}/${total}`);
	console.log(`  Precedence: bulk/list   ${pct(counts.precedenceBulk).padStart(7)}  ${counts.precedenceBulk}/${total}`);
	console.log(`  Auto-Submitted          ${pct(counts.autoSubmitted).padStart(7)}  ${counts.autoSubmitted}/${total}`);
	console.log(`  From: noreply pattern   ${pct(counts.fromNoReply).padStart(7)}  ${counts.fromNoReply}/${total}`);
	console.log(`  From: marketing domain  ${pct(counts.fromMarketingDomain).padStart(7)}  ${counts.fromMarketingDomain}/${total}`);
	console.log(`  Authentication-Results  ${pct(counts.authResultsDmarcPass).padStart(7)}  ${counts.authResultsDmarcPass}/${total}`);
	console.log(`  text/calendar (.ics)    ${pct(counts.icsAttachment).padStart(7)}  ${counts.icsAttachment}/${total}`);
	console.log('');
	console.log('Aggregate (composite of above):');
	console.log(`  Any marketing signal    ${pct(counts.anySignal).padStart(7)}  ${counts.anySignal}/${total}`);
	console.log(`  Gray area (no signal)   ${pct(counts.noSignal).padStart(7)}  ${counts.noSignal}/${total}`);
	console.log(`  Fetch errors            ${counts.fetchErrors}`);
	console.log('');
	console.log('Sample of gray-area messages (would need LLM):');
	for (const ex of grayArea) {
		console.log(`  uid=${ex.uid}  ${(ex.from || '?').slice(0, 40).padEnd(40)}  ${(ex.subject || '').slice(0, 60)}`);
	}
	console.log('');
	console.log('Sample of strong-signal messages (rule-classifiable):');
	for (const ex of strongMarketing) {
		console.log(`  uid=${ex.uid}  ${(ex.from || '?').slice(0, 40).padEnd(40)}  signals=[${ex.signals.join(',')}]`);
	}
	console.log('');
	console.log('═══════════════════════════════════════════════════════');
}

main().then(() => process.exit(0)).catch((err) => {
	console.error('[scan] fatal:', err);
	process.exit(1);
});
