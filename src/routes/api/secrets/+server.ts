import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMaskedSecrets, setSecret, removeSecret } from '$lib/secrets.js';

/** GET /api/secrets — list all platform secrets (masked, never raw values) */
export const GET: RequestHandler = async () => {
	return json(getMaskedSecrets());
};

/** POST /api/secrets — set or remove a secret */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { action, key, value } = await request.json();

		if (!key || typeof key !== 'string') {
			return json({ error: 'Missing secret key' }, { status: 400 });
		}

		if (action === 'remove') {
			removeSecret(key);
			return json({ ok: true, action: 'removed', key });
		}

		// Default action: set
		if (!value || typeof value !== 'string') {
			return json({ error: 'Missing secret value' }, { status: 400 });
		}

		setSecret(key, value);
		return json({ ok: true, action: 'set', key });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 400 });
	}
};
