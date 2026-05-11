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
import { fetchTikTok, probeCapabilities as probeTikTokCapabilities } from '../../tiktok/index.js';
import { dispatchVaultSave } from '../../vault-save/index.js';
import { recordToolCall, assertManifestParity } from './registry.js';
import { setPending, formatProposal } from '../../orchestrator/pending-proposals.js';
import {
	listMessages,
	markMessageProcessed,
	correctClassification,
	type FilterCategory,
} from '../../inbox/index.js';
import {
	getImgCount,
	incrementImgCount,
	getYoutubeCount,
	incrementYoutubeCount,
	getTiktokCount,
	incrementTiktokCount,
	ymdInTimezone,
	insertCommitment,
} from '../../channels/whatsapp/heartbeat-state.js';
import { runSkill } from '../../skills/index.js';
import type { ChatSkillEntry } from '../../skills/index.js';
import type {
	ImgConfigSlice,
	YoutubeConfigSlice,
	TikTokConfigSlice,
	RemindersConfigSlice,
	HeartbeatConfigSlice,
} from '../types.js';

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
	/** ADR-024 — TikTok fetch config. When undefined or `enabled: false`,
	 *  the `tiktokFetch` tool is dropped from the registry entirely (the
	 *  capability probe in src/lib/tiktok/whisper.ts also drops it when
	 *  yt-dlp/ffmpeg/whisper-cli are missing on the host). */
	tiktokConfig?: TikTokConfigSlice;
	account?: string;
	timezone?: string;
	/** ADR-025 — chat channel for this turn. `scheduleReminder` reads this
	 *  to refuse off-channel (Telegram has no heartbeat reader for
	 *  commitments). Undefined → tool degrades to graceful refusal. */
	channel?: 'whatsapp' | 'telegram';
	/** ADR-025 — reminders config snapshot. Gates `scheduleReminder`. */
	remindersConfig?: RemindersConfigSlice;
	/** ADR-025 — heartbeat config snapshot. `scheduleReminder` uses this to
	 *  compose its confirmation `cadenceNote` (outside active hours / muted
	 *  / heartbeat disabled). */
	heartbeatConfig?: HeartbeatConfigSlice;
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
	| {
			kind: 'tiktok';
			url: string;
			videoId: string;
			author: string;
			authorHandle: string;
			caption: string;
			title?: string;
			durationSec: number;
			postedAt?: string;
			views?: number;
			likes?: number;
			comments?: number;
			reposts?: number;
			isPhotoPost: boolean;
			transcript?: string;
			transcriptLang?: string;
			transcriptSource: 'whisper-cpp' | 'gemini' | 'none';
			summary?: string;
			costUsd?: number;
			note?:
				| 'transcript-disabled'
				| 'summary-quota-exceeded'
				| 'whisper-failed'
				| 'whisper-not-installed'
				| 'gemini-failed'
				| 'gemini-not-configured'
				| 'duration-cap-exceeded'
				| 'photo-post-no-audio'
				| 'tiktok-rate-limited'
				| 'cache-hit';
	  }
	| { kind: 'tiktok-error'; url: string; error: string; tier: 'url' | 'metadata' | 'download' | 'whisper' | 'gemini' }
	| { kind: 'vault-save'; path: string; openUrl: string; title: string }
	| { kind: 'vault-save-error'; error: string; title: string }
	| {
			kind: 'reminder-scheduled';
			id: number;
			text: string;
			/** ISO datetime the row will fire at (post-deferral if outside
			 *  active hours / muted). */
			fireAt: string;
			/** Original `dueAt` the model emitted, if different from `fireAt`. */
			requestedAt: string;
			/** Optional human-readable note explaining why `fireAt !==
			 *  requestedAt` or warning that heartbeat is currently off. */
			cadenceNote?: string;
	  }
	| {
			kind: 'reminder-error';
			error:
				| 'reminders-not-supported-on-this-channel'
				| 'reminders-disabled'
				| 'no-target-configured'
				| 'invalid-due-at'
				| 'insert-failed';
			detail?: string;
	  };

/** Build the tool dictionary for an Agent. Returns a stable object so the
 *  AI SDK can produce its tool schema.
 *
 *  ADR-015 — checks manifest parity once per process. Warns (doesn't
 *  throw) when the live tool keys diverge from the static manifest, so
 *  the dev sees the drift in PM2 logs without breaking dispatch. */
export function buildOrchestratorTools(deps: ToolDeps) {
	const tools = buildOrchestratorToolsImpl(deps);
	assertManifestParity(Object.keys(tools));
	return tools;
}

function buildOrchestratorToolsImpl(deps: ToolDeps) {
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

	// ADR-024 — TikTok capability gate. Drop the tool entirely (don't even
	// register it) when the host can't transcribe TikTok clips OR when the
	// settings flag is off. The LLM never sees a tool it can't successfully
	// call — no hallucination surface.
	const ttCaps = probeTikTokCapabilities();
	const tiktokAvailable =
		ttCaps.tierAReady && (deps.tiktokConfig?.enabled ?? true);

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

		...(tiktokAvailable
			? {
					tiktokFetch: tool({
						description:
							'Fetch a TikTok video — author, caption, engagement, duration, and (when needed) speech transcript or summary. ' +
							'Use whenever the user shares a TikTok URL (tiktok.com, vm.tiktok.com, vt.tiktok.com, tiktok.com/t/...) — ' +
							'whether they want to save it, review it, summarize it, quote it, translate it, or ask a question about its content. ' +
							'Modes: "metadata" = author/caption/engagement only (instant, free, for save-shaped intents); ' +
							'"transcript" = adds the full speech transcript via local whisper.cpp (~7-15s, free — for "what does this say" / quote / search intents); ' +
							'"summary" = adds a 2-3 paragraph summary via Gemini (~12-25s, costs cents — for review/summarize intents); ' +
							'"full" = metadata + transcript + summary in one combined call. ' +
							'CALL ONCE per video — pick the most-informative mode you need on the first call ("full" if uncertain). ' +
							'Do NOT re-call this tool with a different mode for the same URL on failure — escalating modes just punches TikTok\'s anti-bot harder. ' +
							'Successive calls within ~10 minutes are served from cache (note="cache-hit") so they\'re cheap, but still avoid repeating yourself. ' +
							'After the tool returns, compose your reply from the structured fields. ' +
							'If the result has note="summary-quota-exceeded" or note="gemini-failed", tell the user we have the transcript/metadata but couldn\'t summarize this turn. ' +
							'If note="tiktok-rate-limited", TikTok\'s anti-bot is currently blocking us. The result MAY have only the author handle (when caption is empty and durationSec is 0) — in that case say "TikTok is rate-limiting us right now — I can see this is from @<authorHandle> but couldn\'t pull the details. Try sharing the link again in a minute or two." If caption is populated, you have the metadata from a prior attempt — share what you have and tell the user the transcript/summary couldn\'t run this turn. Do NOT immediately re-call the tool. ' +
							'If note="photo-post-no-audio", the URL is a photo carousel with no spoken content — only the caption is meaningful. ' +
							'If note="duration-cap-exceeded", the clip is too long to transcribe; only the caption is available.',
						inputSchema: z.object({
							url: z.string().min(1).describe('Full TikTok URL or share link'),
							mode: z
								.enum(['metadata', 'transcript', 'summary', 'full'])
								.describe(
									'metadata = instant + free; transcript = +full transcript via local whisper; summary = +Gemini summary; full = both. Default to "transcript" for review/quote phrasing, "metadata" for save phrasing, "summary" only when the user asks for a summary or analysis.',
								),
						}),
						execute: async ({ url, mode }): Promise<ToolResult> => {
							logToolCall('tiktokFetch', { url, mode });

							let summaryQuotaExceeded = false;
							const willCallGemini =
								(mode === 'summary' || mode === 'full') &&
								(deps.tiktokConfig?.enabled ?? false) &&
								!!deps.senderNumber;
							if (willCallGemini && deps.tiktokConfig && deps.senderNumber) {
								const tz = deps.timezone ?? 'Asia/Dubai';
								const today = ymdInTimezone(tz);
								const count = getTiktokCount(deps.senderNumber, today);
								if (count >= deps.tiktokConfig.maxPerDay) {
									summaryQuotaExceeded = true;
								}
							}

							const outcome = await fetchTikTok(url, {
								mode,
								tiktokConfig: deps.tiktokConfig,
								summaryQuotaExceeded,
							});

							if (!outcome.ok) {
								return {
									kind: 'tiktok-error',
									url: outcome.error.url,
									error: outcome.error.error,
									tier: outcome.error.tier,
								};
							}

							const r = outcome.result;
							// Increment quota only when Gemini actually produced a summary.
							// transcriptSource='gemini' alone isn't enough — we want to
							// charge against the cap when Tier C ran, regardless of
							// whether transcript or summary came out of it.
							if (
								r.summary &&
								deps.senderNumber &&
								deps.tiktokConfig &&
								!summaryQuotaExceeded
							) {
								const tz = deps.timezone ?? 'Asia/Dubai';
								incrementTiktokCount(deps.senderNumber, ymdInTimezone(tz));
							}

							return {
								kind: 'tiktok',
								url: r.url,
								videoId: r.videoId,
								author: r.metadata.author,
								authorHandle: r.metadata.authorHandle,
								caption: r.metadata.caption,
								title: r.metadata.title,
								durationSec: r.metadata.durationSec,
								postedAt: r.metadata.postedAt,
								views: r.metadata.views,
								likes: r.metadata.likes,
								comments: r.metadata.comments,
								reposts: r.metadata.reposts,
								isPhotoPost: r.isPhotoPost,
								transcript: r.transcript,
								transcriptLang: r.transcriptLang,
								transcriptSource: r.transcriptSource,
								summary: r.summary,
								costUsd: r.costUsd,
								note: r.note,
							};
						},
					}),
				}
			: {}),

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

		scheduleReminder: tool({
			description:
				'Schedule a one-time reminder for the user. ' +
				'Use ONLY when the user explicitly asks to be reminded ("remind me to X at Y", "ping me tomorrow about Z"). ' +
				'NEVER use for discussion ("do you remember when..."), vague intents ("I should probably do X someday"), or inferred follow-ups from the conversation. ' +
				'Emit `dueAt` as an ISO 8601 datetime WITH timezone offset — parse natural language ' +
				'("tomorrow 11am", "next Monday morning") relative to the user\'s timezone (Asia/Dubai unless context overrides). ' +
				'Reminders fire on the WhatsApp heartbeat (within ~30 min of the due time) and only inside the user\'s active hours. ' +
				'If the user names a time outside active hours (e.g. "remind me at 3 am"), the system defers to the start of the next active window — the tool result\'s `cadenceNote` tells you when it will actually fire so you can confirm honestly. ' +
				'Reminders are WhatsApp-only today (Telegram returns `reminders-not-supported-on-this-channel`). ' +
				'After the tool returns successfully, confirm to the user: "OK — I\'ll remind you about <text> on <date> around <time>" — include the cadenceNote when present.',
			inputSchema: z.object({
				text: z
					.string()
					.min(2)
					.max(200)
					.describe(
						'The reminder body the user will see, phrased as a third-person nudge ("Call your dad", "Check the PR feedback"). Keep it imperative and short.',
					),
				dueAt: z
					.string()
					.datetime({ offset: true })
					.describe(
						'ISO 8601 datetime WITH timezone offset, e.g. "2026-05-12T11:00:00+04:00". Parse from natural language relative to Asia/Dubai unless the user specifies a different timezone.',
					),
			}),
			execute: async ({ text, dueAt }): Promise<ToolResult> => {
				logToolCall('scheduleReminder', { text: text.slice(0, 60), dueAt });

				// Channel gate — V1 is WhatsApp-only. Telegram has no heartbeat
				// reader for commitments today.
				if (deps.channel && deps.channel !== 'whatsapp') {
					return {
						kind: 'reminder-error',
						error: 'reminders-not-supported-on-this-channel',
						detail: `channel=${deps.channel}`,
					};
				}

				// Reminders feature gate.
				if (!deps.remindersConfig?.enabled) {
					return { kind: 'reminder-error', error: 'reminders-disabled' };
				}

				// Need a target (E.164 phone) to scope the row to a conversation.
				const target = deps.senderNumber;
				if (!target) {
					return { kind: 'reminder-error', error: 'no-target-configured' };
				}

				// Parse + sanity-check dueAt. Zod already validated format; here
				// we reject past-dated reminders (model occasionally emits the
				// current year when it meant next year).
				const requestedTs = Date.parse(dueAt);
				if (Number.isNaN(requestedTs)) {
					return { kind: 'reminder-error', error: 'invalid-due-at', detail: dueAt };
				}
				if (requestedTs < Date.now()) {
					return {
						kind: 'reminder-error',
						error: 'invalid-due-at',
						detail: 'dueAt is in the past',
					};
				}

				// Compute effective fire time + cadenceNote — respect active
				// hours and muteUntil. Heartbeat-disabled gets a warning but
				// still inserts (the user can re-enable heartbeat later).
				const hb = deps.heartbeatConfig;
				let fireAtMs = requestedTs;
				const cadenceNoteParts: string[] = [];

				if (hb?.muteUntil) {
					const muteEnd = Date.parse(hb.muteUntil);
					if (!Number.isNaN(muteEnd) && muteEnd > fireAtMs) {
						fireAtMs = muteEnd;
						cadenceNoteParts.push(
							`heartbeat is muted until ${new Date(muteEnd).toISOString()} — reminder will fire just after`,
						);
					}
				}

				if (hb?.activeHours) {
					const deferred = deferToActiveWindow(fireAtMs, hb.activeHours);
					if (deferred !== fireAtMs) {
						const tz = hb.activeHours.timezone;
						const startLocal = formatInTz(deferred, tz);
						cadenceNoteParts.push(
							`requested time is outside active hours (${hb.activeHours.start}–${hb.activeHours.end} ${tz}); will fire at ${startLocal}`,
						);
						fireAtMs = deferred;
					}
				}

				if (hb && hb.enabled === false) {
					cadenceNoteParts.push(
						"heartbeat is currently OFF — this reminder is saved but won't fire until you re-enable it",
					);
				}

				let id: number;
				try {
					id = insertCommitment({
						channel: 'whatsapp',
						target,
						suggestedText: text,
						dueAfterTs: fireAtMs,
						sourceMsgId: null,
						confidence: 1.0,
						source: 'user-explicit',
					});
				} catch (err) {
					return {
						kind: 'reminder-error',
						error: 'insert-failed',
						detail: (err as Error).message,
					};
				}

				return {
					kind: 'reminder-scheduled',
					id,
					text,
					fireAt: new Date(fireAtMs).toISOString(),
					requestedAt: dueAt,
					cadenceNote: cadenceNoteParts.length > 0 ? cadenceNoteParts.join('; ') : undefined,
				};
			},
		}),

		'inbox-list-queued': tool({
			description:
				"List the user's queued inbox messages (post-Layer-2 filter, agent-relevant only). " +
				"Use when the user asks 'what's in my inbox', 'any new emails', 'show me bank alerts', 'what came in today'. " +
				"Filter by category for targeted queries: personal (human mail), transactional (bank/orders/receipts), notification (service alerts), unclassified (filter wasn't confident). " +
				"Returns newest first.",
			inputSchema: z.object({
				category: z
					.enum(['personal', 'transactional', 'notification', 'unclassified'])
					.optional()
					.describe('Optional category filter. Omit to see everything queued.'),
				since: z
					.string()
					.optional()
					.describe('Lower bound for date_received. Accepts ISO datetime ("2026-05-11T00:00:00Z") or the literal strings "today" / "yesterday" / "week".'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe('Max rows to return (default 20).'),
				accountId: z
					.string()
					.optional()
					.describe('Restrict to one inbox account (rare — usually omit).'),
			}),
			execute: async ({ category, since, limit, accountId }): Promise<ToolResult> => {
				logToolCall('inbox-list-queued', { category, since, limit, accountId });
				const sinceMs = parseSinceArg(since);
				const result = listMessages({
					status: 'queued',
					category,
					since: sinceMs,
					limit: limit ?? 20,
					accountId,
				});
				if (result.messages.length === 0) {
					return { kind: 'reply', text: 'No queued messages match.' };
				}
				const lines = result.messages.map((m, i) => {
					const sender = m.fromName || m.fromAddress;
					const cat = m.category ?? '?';
					const when = formatRelativeDate(m.dateReceived);
					return `${i + 1}. [${cat}] ${sender} — ${m.subject}  · ${when}  (id ${m.id})`;
				});
				const head = `${result.total} queued message${result.total === 1 ? '' : 's'}` +
					(category ? ` in ${category}` : '') +
					':';
				return { kind: 'reply', text: `${head}\n${lines.join('\n')}` };
			},
		}),

		'inbox-mark-processed': tool({
			description:
				"Mark an inbox message as processed (agent has handled it). The message transitions queued → processed; it stays cached for 365 days as audit trail but stops appearing in queued listings. " +
				"Use after summarizing, routing-to-vault, replying, or otherwise handling a message.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
			}),
			execute: async ({ messageId }): Promise<ToolResult> => {
				logToolCall('inbox-mark-processed', { messageId });
				const ok = markMessageProcessed(messageId);
				return {
					kind: 'reply',
					text: ok
						? `Message ${messageId} marked processed.`
						: `Message ${messageId} not found or not in queued state.`,
				};
			},
		}),

		'inbox-correct-classification': tool({
			description:
				"Correct the Layer 2 classification of a message and update the cache so future similar messages get the new category. " +
				"Use when the user pushes back (\"that's not promotional, it's a receipt\") or when the agent notices a clear miscategorization. " +
				"Scope can be 'this' (this message only) or 'pattern' (this message + all matching siblings via the cache signature).",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
				category: z.enum([
					'personal',
					'transactional',
					'notification',
					'promotional',
					'bulk',
					'unclassified',
				]),
				scope: z.enum(['this', 'pattern']).optional(),
				reason: z.string().max(200).optional(),
			}),
			execute: async ({ messageId, category, scope, reason }): Promise<ToolResult> => {
				logToolCall('inbox-correct-classification', { messageId, category, scope });
				const result = correctClassification(messageId, {
					category: category as FilterCategory,
					scope: scope ?? 'pattern',
					reason,
				});
				if (!result.ok) {
					return {
						kind: 'reply',
						text: `Could not update message ${messageId}: ${result.reason ?? 'unknown'}.`,
					};
				}
				const sib = result.siblingsUpdated;
				const tail =
					(scope ?? 'pattern') === 'pattern' && sib > 0
						? ` Re-classified ${sib} matching sibling${sib === 1 ? '' : 's'}.`
						: '';
				return {
					kind: 'reply',
					text: `Updated message ${messageId} to ${category}.${tail}`,
				};
			},
		}),
	};
}

/**
 * Coerce a `since` arg into epoch-ms for inbox-list-queued. Accepts ISO
 * datetimes and a handful of natural-language tokens. Returns undefined
 * when the input is empty or unparseable — the caller treats that as "no
 * lower bound" rather than 400'ing.
 */
function parseSinceArg(since?: string): number | undefined {
	if (!since) return undefined;
	const lower = since.toLowerCase().trim();
	const now = Date.now();
	if (lower === 'today') {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	if (lower === 'yesterday') {
		return now - 24 * 60 * 60 * 1000;
	}
	if (lower === 'week' || lower === 'this week') {
		return now - 7 * 24 * 60 * 60 * 1000;
	}
	const parsed = Date.parse(since);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Lightweight "5h ago" / "2d ago" formatter for the listing UI. */
function formatRelativeDate(ms: number): string {
	const diff = Date.now() - ms;
	const min = Math.round(diff / 60_000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const d = Math.round(hr / 24);
	return `${d}d ago`;
}

/** Given a ts (ms) and an active-hours window, return the same ts if it
 *  falls inside the window today, or the next window-start ts otherwise.
 *  Pure helper for `scheduleReminder` — no DB access, no clock side effects. */
function deferToActiveWindow(
	tsMs: number,
	window: { start: string; end: string; timezone: string },
): number {
	const tz = window.timezone;
	const [startH, startM] = window.start.split(':').map(Number);
	const [endH, endM] = window.end.split(':').map(Number);
	const startMinutes = startH * 60 + startM;
	const endMinutes = endH * 60 + endM;

	const localMinutes = localMinutesAt(tsMs, tz);
	if (localMinutes >= startMinutes && localMinutes < endMinutes) {
		return tsMs;
	}

	// Outside window. Compute the next start-of-window in `tz`.
	const startLocalToday = tsAtLocalTime(tsMs, tz, startH, startM);
	if (startLocalToday > tsMs) {
		return startLocalToday;
	}
	// Window has already passed today — defer to tomorrow's start.
	return startLocalToday + 24 * 60 * 60 * 1000;
}

/** Minutes-since-local-midnight at `tsMs` in `tz`. */
function localMinutesAt(tsMs: number, tz: string): number {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const parts = fmt.formatToParts(new Date(tsMs));
	const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
	const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
	return h * 60 + m;
}

/** Snap `tsMs` to local HH:MM in `tz`, returning the UTC ms. Coarse —
 *  ignores DST transitions on the exact transition day; acceptable for
 *  reminder deferral where ±1h on the rare DST-edge ticks is fine. */
function tsAtLocalTime(tsMs: number, tz: string, hh: number, mm: number): number {
	const ymd = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(tsMs));
	// Build a date string in the target tz, then resolve to UTC by computing
	// the tz offset at that local time via a probe Date.
	const iso = `${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
	const asUtc = Date.parse(`${iso}Z`);
	const probeLocal = localMinutesAt(asUtc, tz);
	const offsetMin = probeLocal - (hh * 60 + mm);
	return asUtc - offsetMin * 60 * 1000;
}

function formatInTz(tsMs: number, tz: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(tsMs));
}

function logToolCall(name: string, payload: Record<string, unknown>): void {
	const argPreview = JSON.stringify(payload);
	console.log(`[orchestrator-v2] tool:${name}`, argPreview);
	// ADR-015 — feed the in-memory ring buffer that powers /orchestrator/tools.
	recordToolCall(name, argPreview.slice(0, 240));
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
