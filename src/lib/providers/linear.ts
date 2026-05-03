import type { ProviderTester, TestResult } from './types.js';
import { withNetworkGuard } from './_shared.js';

const ENV_KEY = 'LINEAR_API_KEY';

export const provider: ProviderTester = {
	id: 'linear',
	name: 'Linear',
	field: {
		envKey: ENV_KEY,
		label: 'API Key',
		link: 'https://linear.app/settings/account/security',
	},
	test: () =>
		withNetworkGuard(ENV_KEY, process.env[ENV_KEY], async (): Promise<TestResult> => {
			const key = process.env[ENV_KEY] as string;
			const res = await fetch('https://api.linear.app/graphql', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: key,
				},
				body: JSON.stringify({ query: 'query { viewer { id } }' }),
			});
			if (res.status === 401) {
				return { ok: false, status: 'unauthorized', message: 'API key rejected.' };
			}
			if (res.status === 429) {
				return { ok: false, status: 'ratelimit', message: 'Rate limited — try again shortly.' };
			}
			const body = (await res.json().catch(() => undefined)) as
				| { data?: { viewer?: { id?: string } }; errors?: Array<{ message?: string }> }
				| undefined;
			if (res.ok && body?.data?.viewer?.id) {
				return { ok: true, status: 'ok' };
			}
			const message = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
			return { ok: false, status: 'invalid', message };
		}),
};
