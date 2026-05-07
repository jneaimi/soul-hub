/**
 * Tool factory for the v2 orchestrator (ADR-009).
 *
 * Phase 2 wires real handlers behind the tool stubs:
 *   - reply           — returns text as-is
 *   - webSearch       — `dispatchWebSearch` + `formatWebSearchForChat`
 *   - vaultSearch     — `dispatchVaultChat`
 *   - generateImage   — `dispatchImg` (with quota check + count + lastImage cache)
 *   - dispatchAgent   — confirmed=false → `setPending`; confirmed=true → Phase 3
 *   - invokeSkill     — Phase 4
 *
 * Tools execute side effects and return rich result objects so the LLM
 * can chain (e.g. `webSearch → dispatchAgent`). decide-v2 walks tool
 * results to build the `V2Output` for the inbound handler.
 *
 * Tool descriptions carry the routing logic — keep them tight; the
 * model reads these to decide. Anything in the system prompt is
 * advisory; tool descriptions are load-bearing.
 */

import { tool } from 'ai';
import { z } from 'zod';

import { dispatchWebSearch, formatWebSearchForChat } from '../../web-search/index.js';
import { dispatchVaultChat } from '../../vault-chat/index.js';
import { dispatchImg, rememberLastImage } from '../../img/index.js';
import { fetchYoutube } from '../../youtube/index.js';
import { dispatchVaultSave } from '../../vault-save/index.js';
import { setPending, formatProposal } from '../../orchestrator/pending-proposals.js';
import {
	getImgCount,
	incrementImgCount,
	getYoutubeCount,
	incrementYoutubeCount,
	ymdInTimezone,
} from '../../channels/whatsapp/heartbeat-state.js';
import { runSkill } from '../../skills/index.js';
import type { ChatSkillEntry } from '../../skills/index.js';
import type { ImgConfigSlice, YoutubeConfigSlice } from '../types.js';

export interface ToolDeps {
	conversationKey?: string;
	senderNumber?: string;
	dispatchableAgentIds: readonly string[];
	/** Chat-invokable skills from the registry. The `invokeSkill` tool
	 *  description and `skillName` enum are built from these — empty list
	 *  means the tool registers with a permissive `z.string()` and the
	 *  description warns the model not to invoke it. */
	chatSkills: readonly ChatSkillEntry[];
	imgConfig?: ImgConfigSlice;
	/** ADR-012 — YouTube fetch config. When undefined or `enabled: false`,
	 *  `youtubeFetch` still runs Tier A (oEmbed metadata) but skips the
	 *  Gemini transcript tier and surfaces a `note: 'transcript-disabled'`
	 *  hint in the result. */
	youtubeConfig?: YoutubeConfigSlice;
	account?: string;
	timezone?: string;
	/** ADR-009 Phase 5 — A/B branch label that decided this turn. Forwarded
	 *  to `setPending` so the proposal_history audit row can be grouped by
	 *  branch in analytics. Undefined when v2 isn't running an A/B (e.g.
	 *  `ORCHESTRATOR_V2_MODEL` legacy override). */
	modelBranch?: string;
}

/** Tagged-union return type for all tool `execute()` bodies. decide-v2's
 *  result walker discriminates on `kind` to assemble the `V2Output`. */
export type ToolResult =
	| { kind: 'reply'; text: string }
	| { kind: 'web-search'; text: string; query: string }
	| { kind: 'web-search-error'; error: string; query: string }
	| { kind: 'vault-search'; text: string; query: string }
	| { kind: 'vault-search-error'; error: string; query: string }
	| { kind: 'image'; attachPath: string; caption?: string; prompt: string }
	| { kind: 'image-error'; error: string; prompt: string }
	| { kind: 'proposal'; text: string; agentId: string; task: string; label: string }
	| { kind: 'dispatch'; agentId: string; task: string }
	| { kind: 'dispatch-error'; error: string; agentId: string; task: string }
	| { kind: 'invoke-skill'; skillName: string; output: string; durationMs: number }
	| { kind: 'invoke-skill-error'; skillName: string; error: string; durationMs: number }
	| {
			kind: 'youtube';
			url: string;
			videoId: string;
			title: string;
			channel: string;
			thumbnailUrl: string;
			durationSec?: number;
			description?: string;
			summary?: string;
			transcript?: string;
			transcriptSource: 'gemini' | 'none';
			costUsd?: number;
			note?:
				| 'transcript-quota-exceeded'
				| 'transcript-disabled'
				| 'gemini-failed'
				| 'gemini-not-configured';
	  }
	| { kind: 'youtube-error'; url: string; error: string; tier: 'oembed' | 'gemini' | 'url' }
	| { kind: 'vault-save'; path: string; openUrl: string; title: string }
	| { kind: 'vault-save-error'; error: string; title: string };

/** Build the tool dictionary for an Agent. Returns a stable object so the
 *  AI SDK can produce its tool schema. */
export function buildOrchestratorTools(deps: ToolDeps) {
	const agentIdEnum =
		deps.dispatchableAgentIds.length > 0
			? z.enum(deps.dispatchableAgentIds as [string, ...string[]])
			: z.string().describe('(no agents enabled — set chat_dispatchable on at least one)');
	const skillNames = deps.chatSkills.map((s) => s.name);
	const skillNameEnum =
		skillNames.length > 0
			? z.enum(skillNames as [string, ...string[]])
			: z.string().describe('(no skills enabled — none of these will work)');
	const skillToolDescription = buildInvokeSkillDescription(deps.chatSkills);

	return {
		reply: tool({
			description:
				'Reply to the user with a chat message. Use for greetings, conversation, quick known facts, follow-up summaries, or asking a clarification. NOT for unknown facts (use webSearch) or vault lookups (use vaultSearch).',
			inputSchema: z.object({
				text: z.string().min(1).max(2000).describe('The message text shown to the user'),
			}),
			execute: async ({ text }): Promise<ToolResult> => {
				logToolCall('reply', { textPreview: text.slice(0, 60) });
				return { kind: 'reply', text };
			},
		}),

		webSearch: tool({
			description:
				"Quick Gemini-grounded Google Search for current real-world facts (weather, news, today's score, single lookups). Returns chat-formatted answer with one source URL. When the user names a specific source (e.g. \"Khaleej Times\", \"The National\", \"Reuters\"), shape the query as `site:<domain> <topic>` — e.g. `site:khaleejtimes.com today's UAE headlines` — so grounding pulls from that source instead of a broad mix.",
			inputSchema: z.object({
				query: z.string().min(2).max(400).describe('The search query — natural language is fine'),
			}),
			execute: async ({ query }): Promise<ToolResult> => {
				logToolCall('webSearch', { query });
				try {
					const r = await dispatchWebSearch(query);
					const text = formatWebSearchForChat(r);
					return { kind: 'web-search', text, query };
				} catch (err) {
					const error = (err as Error).message ?? String(err);
					return { kind: 'web-search-error', error, query };
				}
			},
		}),

		vaultSearch: tool({
			description:
				'Search the user\'s Obsidian vault for the user\'s OWN saved notes. Use for "do we have research on X", "what did we save about Y", "find my notes on Z", "did I write anything about W". Do NOT use for current events, news, headlines, weather, live scores, or any question about the outside world — those go to webSearch. Vault returning a topic-adjacent note does not satisfy a news / current-events question.',
			inputSchema: z.object({
				query: z.string().min(2).max(400),
			}),
			execute: async ({ query }): Promise<ToolResult> => {
				logToolCall('vaultSearch', { query });
				try {
					const r = await dispatchVaultChat(query, deps.conversationKey);
					return { kind: 'vault-search', text: r.text || '(no reply)', query };
				} catch (err) {
					const error = (err as Error).message ?? String(err);
					return { kind: 'vault-search-error', error, query };
				}
			},
		}),

		generateImage: tool({
			description:
				'Generate a single text-to-image via Gemini Nano Banana. Use ONLY for "make me a picture of X" with NO text overlay, NO video, NO voiceover, NO carousel, NO Arabic text. If the user wants any of those, use dispatchAgent with agentId="media-generator".',
			inputSchema: z.object({
				prompt: z
					.string()
					.min(2)
					.max(1500)
					.describe('Clean visual description, no leading verb (e.g. "a person fishing in the UAE")'),
			}),
			execute: async ({ prompt }): Promise<ToolResult> => {
				logToolCall('generateImage', { promptPreview: prompt.slice(0, 60) });
				if (!deps.imgConfig) {
					return { kind: 'image-error', error: 'Image generation is not configured.', prompt };
				}
				if (!deps.imgConfig.enabled) {
					return {
						kind: 'image-error',
						error:
							'Image generation is disabled in settings. Toggle it on under WhatsApp → Image generation.',
						prompt,
					};
				}
				if (!deps.account) {
					return { kind: 'image-error', error: 'Image generation needs an account name.', prompt };
				}
				if (!deps.senderNumber || !deps.conversationKey) {
					return { kind: 'image-error', error: 'Image generation needs a sender context.', prompt };
				}
				const tz = deps.timezone ?? 'Asia/Dubai';
				const today = ymdInTimezone(tz);
				const count = getImgCount(deps.senderNumber, today);
				if (count >= deps.imgConfig.maxPerDay) {
					return {
						kind: 'image-error',
						error: `You've hit today's image budget (${deps.imgConfig.maxPerDay}/day) — resets midnight ${tz}.`,
						prompt,
					};
				}
				const result = await dispatchImg({
					prompt,
					conversationKey: deps.conversationKey,
					account: deps.account,
					systemPromptPath: deps.imgConfig.systemPromptPath,
					model: deps.imgConfig.model,
				});
				if (result.error) {
					return { kind: 'image-error', error: result.error, prompt };
				}
				incrementImgCount(deps.senderNumber, today);
				rememberLastImage(deps.conversationKey, {
					buffer: result.buffer,
					mimetype: result.mimetype,
					prompt: result.prompt,
				});
				return {
					kind: 'image',
					attachPath: result.path,
					caption: result.caption,
					prompt,
				};
			},
		}),

		dispatchAgent: tool({
			description:
				'Dispatch a heavy specialist agent (runs minutes). OMIT confirmed (or set false) to PROPOSE the dispatch — the user replies "yes" to run it. Set confirmed=true ONLY when the user explicitly confirmed a prior proposal OR used an unambiguous command verb ("research X for me", "draft Y about Z", "review this code", "audit Q").',
			inputSchema: z.object({
				agentId: agentIdEnum,
				// `min(5)` (was `min(20)`): too-tight rejected terse model
				// emissions like "weather image" and the user got a 1-char
				// reply instead of a proposal.
				task: z
					.string()
					.min(5)
					.max(800)
					.describe(
						'Self-contained instruction for the agent. Include all context the agent will need from the conversation.',
					),
				// `confirmed` is .optional() (NOT .default(false)): Zod 4
				// `toJSONSchema` adds defaulted fields to `required`, which
				// pushes the model to emit them — and GLM-4.6 then emits
				// `"false"` (string) which fails `z.boolean()`. Optional +
				// preprocess gives us: model can omit the field, and any
				// string-shaped boolean from the model still parses cleanly.
				confirmed: z
					.preprocess(
						(v) => {
							if (typeof v === 'string') {
								const lower = v.toLowerCase().trim();
								if (lower === 'true' || lower === 'yes' || lower === '1') return true;
								if (
									lower === 'false' ||
									lower === 'no' ||
									lower === '0' ||
									lower === ''
								)
									return false;
							}
							return v;
						},
						z.boolean().optional(),
					)
					.describe('Omit (default false) to propose. true = run now.'),
				proposalLabel: z
					.string()
					.max(80)
					.optional()
					.describe('Required when confirmed is false/omitted. One-line user-facing description of what the agent will do.'),
			}),
			execute: async (args): Promise<ToolResult> => {
				const confirmed = args.confirmed ?? false;
				logToolCall('dispatchAgent', {
					agentId: args.agentId,
					confirmed,
					taskPreview: args.task.slice(0, 60),
				});
				if (confirmed) {
					// Phase 3 — confirmed=true signals "run now". The actual
					// dispatch (capacity check + worker ack + `runInBackground`)
					// happens in the inbound handler's v2Output short-circuit
					// because it needs `envelope.chatJid`, `worker`, and `ctx`
					// that aren't available inside the orchestrator scope.
					return {
						kind: 'dispatch',
						agentId: args.agentId,
						task: args.task,
					};
				}
				// confirmed=false → write to pending_proposals + return formatted text.
				if (!deps.conversationKey) {
					return {
						kind: 'dispatch-error',
						error: 'conversationKey missing — cannot create proposal',
						agentId: args.agentId,
						task: args.task,
					};
				}
				const label = args.proposalLabel ?? `Run ${args.agentId}`;
				const proposal = setPending({
					conversationKey: deps.conversationKey,
					agentId: args.agentId,
					task: args.task,
					label,
					origin: 'natural',
					modelBranch: deps.modelBranch,
				});
				return {
					kind: 'proposal',
					text: formatProposal(proposal),
					agentId: args.agentId,
					task: args.task,
					label,
				};
			},
		}),

		youtubeFetch: tool({
			description:
				'Fetch a YouTube video — title, channel, duration, thumbnail, and (when needed) transcript or summary. ' +
				'Use whenever the user shares a YouTube URL (youtube.com, youtu.be, share.google/...) — ' +
				'whether they want to save it, review it, summarize it, quote it, or ask a question about its content. ' +
				'Modes: "metadata" = title/channel/thumbnail only (instant, free, for save-shaped intents); ' +
				'"summary" = adds a 2-3 paragraph summary via Gemini (~10-25s, costs cents — for review/summarize/quote intents); ' +
				'"transcript" = adds the full transcript text (~25s, costs cents — for "what does he say about X" intents); ' +
				'"full" = metadata + summary + transcript in one call. ' +
				'After the tool returns, compose your reply from the structured fields. ' +
				'If the result has note="transcript-quota-exceeded" or note="gemini-failed", tell the user we have the title and thumbnail but couldn\'t analyze the video this turn.',
			inputSchema: z.object({
				url: z.string().min(1).describe('Full YouTube URL or share link'),
				mode: z
					.enum(['metadata', 'summary', 'transcript', 'full'])
					.describe(
						'metadata = instant + free; summary = +2-3 paragraph summary; transcript = +full transcript; full = both. Default to "summary" for review/summarize phrasing, "metadata" for save phrasing, "transcript" for quote/extract phrasing.',
					),
			}),
			execute: async ({ url, mode }): Promise<ToolResult> => {
				logToolCall('youtubeFetch', { url, mode });

				// Per-target Gemini quota check happens BEFORE the call so we
				// short-circuit to metadata-only when the cap is hit. Increments
				// happen AFTER a successful Gemini turn (failures don't burn
				// the cap).
				let transcriptQuotaExceeded = false;
				const willCallGemini =
					mode !== 'metadata' &&
					(deps.youtubeConfig?.enabled ?? false) &&
					!!deps.senderNumber;
				if (willCallGemini && deps.youtubeConfig && deps.senderNumber) {
					const tz = deps.timezone ?? 'Asia/Dubai';
					const today = ymdInTimezone(tz);
					const count = getYoutubeCount(deps.senderNumber, today);
					if (count >= deps.youtubeConfig.maxPerDay) {
						transcriptQuotaExceeded = true;
					}
				}

				const outcome = await fetchYoutube(url, {
					mode,
					youtubeConfig: deps.youtubeConfig,
					transcriptQuotaExceeded,
				});

				if (!outcome.ok) {
					return {
						kind: 'youtube-error',
						url: outcome.error.url,
						error: outcome.error.error,
						tier: outcome.error.tier,
					};
				}

				const r = outcome.result;
				// Increment quota only when Gemini actually produced content.
				// `transcriptSource === 'gemini'` is the truthful signal — covers
				// both summary and transcript modes (any mode that hit Tier B).
				if (
					r.transcriptSource === 'gemini' &&
					deps.senderNumber &&
					deps.youtubeConfig &&
					!transcriptQuotaExceeded
				) {
					const tz = deps.timezone ?? 'Asia/Dubai';
					incrementYoutubeCount(deps.senderNumber, ymdInTimezone(tz));
				}

				return {
					kind: 'youtube',
					url: r.url,
					videoId: r.videoId,
					title: r.metadata.title,
					channel: r.metadata.channel,
					thumbnailUrl: r.metadata.thumbnailUrl,
					durationSec: r.metadata.durationSec,
					description: r.metadata.description,
					summary: r.summary,
					transcript: r.transcript,
					transcriptSource: r.transcriptSource,
					costUsd: r.costUsd,
					note: r.note,
				};
			},
		}),

		vaultSave: tool({
			description:
				"Save composed content to the user's Obsidian vault as a markdown note. " +
				"Use ONLY when the user explicitly asks to save / capture / remember / add to notes / write down / store. " +
				"NEVER call this for discussion-only requests. " +
				"For multi-step flows (e.g. user asks to save a YouTube video), call the upstream tool first (youtubeFetch with mode=summary), then synthesize a clean note body, THEN call vaultSave with the synthesized title + body. " +
				"Always writes to the inbox zone — the user curates from there. After it returns, include the openUrl in your reply so the user can open the note.",
			inputSchema: z.object({
				title: z
					.string()
					.min(2)
					.max(120)
					.describe(
						'Short specific title (≤ 12 words). Used for the filename slug and as the H1.',
					),
				content: z
					.string()
					.min(1)
					.max(50_000)
					.describe(
						'Markdown body of the note. Pre-synthesized — include any context (summary, key points, source link) the user will want when reading later. Do not include the title as an H1; the vault renderer adds it.',
					),
				type: z
					.enum(['draft', 'reference', 'learning', 'idea'])
					.describe(
						'Note type. "draft" for general captures, "reference" for material to revisit, "learning" for things learned, "idea" for sparks/concepts. Default to "draft" when unsure.',
					),
				tags: z
					.array(z.string().min(1).max(40))
					.max(8)
					.describe(
						'Up to 8 short kebab-case tags (no leading "#"). Pick from the content topic, source, and intent.',
					),
				sourceUrl: z
					.string()
					.url()
					.optional()
					.describe(
						'When the saved content was derived from a URL (YouTube, article), pass it here so the note can back-link.',
					),
			}),
			execute: async ({ title, content, type, tags, sourceUrl }): Promise<ToolResult> => {
				logToolCall('vaultSave', {
					title: title.slice(0, 60),
					type,
					tagCount: tags.length,
					hasSource: !!sourceUrl,
					contentChars: content.length,
				});
				const outcome = await dispatchVaultSave({
					title,
					content,
					type,
					tags,
					sourceUrl,
				});
				if (!outcome.ok) {
					return { kind: 'vault-save-error', error: outcome.error, title: outcome.title };
				}
				return {
					kind: 'vault-save',
					path: outcome.path,
					openUrl: outcome.openUrl,
					title: outcome.title,
				};
			},
		}),

		invokeSkill: tool({
			description: skillToolDescription,
			inputSchema: z.object({
				skillName: skillNameEnum,
				args: z
					.string()
					.max(2000)
					.describe(
						'Skill arguments — natural-language string is fine for prompt-injection skills (arabic, draft, think); JSON-shaped object as a string for script skills (when seeded). The skill validates against its own schema.',
					),
			}),
			execute: async ({ skillName, args }): Promise<ToolResult> => {
				logToolCall('invokeSkill', { skillName, argsPreview: args.slice(0, 60) });
				// Args arrive as a string. Try JSON parse first; fall back to
				// the raw string so prompt-injection skills can take free-form
				// natural language without forcing the model to JSON-encode.
				let parsedArgs: unknown = args;
				if (args.trim().startsWith('{') || args.trim().startsWith('[')) {
					try {
						parsedArgs = JSON.parse(args);
					} catch {
						// Keep as string — runSkill will hand to the runner which
						// formats appropriately for prompt-injection.
					}
				}
				const result = await runSkill(skillName, parsedArgs);
				if (result.ok) {
					return {
						kind: 'invoke-skill',
						skillName,
						output: result.output,
						durationMs: result.durationMs,
					};
				}
				return {
					kind: 'invoke-skill-error',
					skillName,
					error: result.error,
					durationMs: result.durationMs,
				};
			},
		}),
	};
}

function logToolCall(name: string, payload: Record<string, unknown>): void {
	console.log(`[orchestrator-v2] tool:${name}`, JSON.stringify(payload));
}

/** Build the `invokeSkill` tool description dynamically from the registry.
 *  Lists each skill's chat_description + 1 example so the model can pick
 *  + format args correctly. Empty registry → terse description warning the
 *  model not to call it. */
function buildInvokeSkillDescription(chatSkills: readonly ChatSkillEntry[]): string {
	const head =
		'Invoke a Claude Skill — fast scoped utility (seconds, not minutes). Prefer this over dispatchAgent for narrow tasks. Skills run synchronously and the output is threaded back to you so you can compose the final reply.';
	if (chatSkills.length === 0) {
		return `${head}\n\n(No skills are enabled — do not call this tool.)`;
	}
	const lines: string[] = [head, '', 'Available skills:'];
	for (const s of chatSkills) {
		const desc = s.chat_description.replace(/\s+/g, ' ').trim();
		lines.push(`- ${s.name}: ${desc}`);
		if (s.examples.length > 0) {
			const e = s.examples[0];
			lines.push(`  Example: invokeSkill({ skillName: "${s.name}", args: ${JSON.stringify(e.args)} })`);
		}
	}
	return lines.join('\n');
}
