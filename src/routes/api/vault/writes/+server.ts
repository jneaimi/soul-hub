import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getVaultEngine } from '$lib/vault/index.js'

/** GET /api/vault/writes — Agent write audit trail */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine()
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 })
	}

	const agent = url.searchParams.get('agent') || undefined
	const zone = url.searchParams.get('zone') || undefined
	const limitParam = parseInt(url.searchParams.get('limit') || '50', 10)
	const limit = Math.min(Math.max(1, limitParam), 200)

	const log = engine.getWriteLog({ agent, zone, limit })
	return json({ entries: log, total: log.length })
}
