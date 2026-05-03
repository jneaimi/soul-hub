import { generateText } from 'ai';
import type { JSONValue } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ChatProvider, ChatRequest, ChatResult } from './types.js';

const ENV_KEY = 'OPENROUTER_API_KEY';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/** Detect Anthropic-routed slugs so we can pin provider order to keep
 *  top-level `cache_control` working. Bedrock and Vertex routes silently
 *  drop the field, so we have to force the upstream to be Anthropic. */
function isAnthropicModel(modelId: string): boolean {
	return modelId.startsWith('anthropic/');
}

export const openrouter: ChatProvider = {
	id: 'openrouter',
	name: 'OpenRouter',
	defaultModel: DEFAULT_MODEL,
	envKey: ENV_KEY,

	available(): boolean {
		return !!process.env[ENV_KEY];
	},

	async generate(req: ChatRequest): Promise<ChatResult> {
		const apiKey = process.env[ENV_KEY];
		if (!apiKey) throw new Error(`${ENV_KEY} is not set`);

		const client = createOpenRouter({ apiKey });
		const modelId = req.model ?? DEFAULT_MODEL;

		const providerOptions: Record<string, Record<string, JSONValue>> = {};
		if (req.cacheControl && isAnthropicModel(modelId)) {
			providerOptions.openrouter = {
				cacheControl: { type: req.cacheControl },
				// Pin Anthropic-direct so top-level cache_control survives the hop.
				provider: { order: ['Anthropic'] },
			};
		}

		const result = await generateText({
			model: client(modelId),
			system: req.system,
			messages: req.messages,
			maxOutputTokens: req.maxOutputTokens,
			abortSignal: req.signal,
			...(Object.keys(providerOptions).length > 0 && { providerOptions }),
		});

		return {
			text: result.text,
			finishReason: result.finishReason,
			usage: {
				inputTokens: result.usage?.inputTokens,
				outputTokens: result.usage?.outputTokens,
				totalTokens: result.usage?.totalTokens,
			},
			providerId: 'openrouter',
			modelId,
		};
	},
};
