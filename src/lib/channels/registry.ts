import type { ChannelAdapter, ChannelConfig, ChannelMeta, ChannelsSettings, SendResult } from './types.js';
import { adapter as telegramAdapter } from './telegram.js';

/** All registered channel adapters */
const adapters = new Map<string, ChannelAdapter>();

// Register built-in adapters
adapters.set('telegram', telegramAdapter);

/** Get all registered adapter metadata (for settings UI) */
export function getAllChannelMeta(): ChannelMeta[] {
	return Array.from(adapters.values()).map((a) => a.meta);
}

/** Get a specific adapter by id */
export function getAdapter(id: string): ChannelAdapter | undefined {
	return adapters.get(id);
}

/** Get the default adapter for a given action based on channel settings */
export function getDefaultAdapter(
	action: 'send' | 'prompt' | 'listen',
	channelsConfig: ChannelsSettings,
): ChannelAdapter | undefined {
	// Find first enabled channel that has this action in defaultFor
	for (const [id, cfg] of Object.entries(channelsConfig)) {
		if (cfg.enabled && cfg.defaultFor.includes(action)) {
			const adapter = adapters.get(id);
			if (adapter?.isConfigured()) return adapter;
		}
	}
	// Fallback: first enabled + configured adapter that supports the action
	for (const [id, cfg] of Object.entries(channelsConfig)) {
		if (cfg.enabled) {
			const adapter = adapters.get(id);
			if (adapter?.isConfigured() && adapter.meta.actions.includes(action)) {
				return adapter;
			}
		}
	}
	return undefined;
}

/** Send a message via a specific channel or the default one */
export async function sendViaChannel(
	channelId: string | undefined,
	channelsConfig: ChannelsSettings,
	message: string,
	attachPath?: string,
): Promise<SendResult> {
	let adapter: ChannelAdapter | undefined;

	if (channelId) {
		adapter = adapters.get(channelId);
		if (!adapter) {
			return { ok: false, error: `Unknown channel: ${channelId}` };
		}
	} else {
		adapter = getDefaultAdapter('send', channelsConfig);
		if (!adapter) {
			return { ok: false, error: 'No default channel configured for send' };
		}
	}

	const cfg = channelsConfig[adapter.meta.id];
	if (cfg && !cfg.enabled) {
		return { ok: false, error: `Channel "${adapter.meta.name}" is disabled` };
	}

	if (!adapter.isConfigured()) {
		return {
			ok: false,
			error: `Channel "${adapter.meta.name}" is not configured — missing env vars`,
		};
	}

	return adapter.send(message, attachPath);
}

/** Default channel config for all adapters */
export function getDefaultChannelsConfig(): ChannelsSettings {
	const defaults: ChannelsSettings = {};
	for (const [id, adapter] of adapters) {
		defaults[id] = {
			enabled: adapter.isConfigured(),
			label: adapter.meta.name,
			defaultFor: adapter.meta.actions.includes('send') ? ['send'] : [],
		};
	}
	return defaults;
}
