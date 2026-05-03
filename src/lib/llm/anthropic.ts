import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ChatProvider, ChatRequest, ChatResult } from './types.js';

const ENV_KEY = 'ANTHROPIC_API_KEY';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Anthropic direct provider — used for Claude routes when the CLI path is
 *  unavailable or explicitly bypassed. Preserves prompt caching via
 *  `providerOptions.anthropic.cacheControl`. */
export const anthropic: ChatProvider = {
	id: 'anthropic',
	name: 'Anthropic',
	defaultModel: DEFAULT_MODEL,
	envKey: ENV_KEY,

	available(): boolean {
		return !!process.env[ENV_KEY];
	},

	async generate(req: ChatRequest): Promise<ChatResult> {
		const apiKey = process.env[ENV_KEY];
		if (!apiKey) throw new Error(`${ENV_KEY} is not set`);

		const client = createAnthropic({ apiKey });
		const modelId = req.model ?? DEFAULT_MODEL;

		const result = await generateText({
			model: client(modelId),
			system: req.system,
			messages: req.messages,
			maxOutputTokens: req.maxOutputTokens,
			abortSignal: req.signal,
			...(req.cacheControl && {
				providerOptions: {
					anthropic: { cacheControl: { type: req.cacheControl } },
				},
			}),
		});

		return {
			text: result.text,
			finishReason: result.finishReason,
			usage: {
				inputTokens: result.usage?.inputTokens,
				outputTokens: result.usage?.outputTokens,
				totalTokens: result.usage?.totalTokens,
			},
			providerId: 'anthropic',
			modelId,
		};
	},
};
