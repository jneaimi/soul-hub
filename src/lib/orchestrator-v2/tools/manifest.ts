/**
 * Tools manifest — first-class registry of orchestrator-v2 tools (ADR-015).
 *
 * Tools live as closures inside `buildOrchestratorTools()` for runtime
 * (the AI SDK needs the live `tool()` objects with bound deps). This
 * manifest is the parallel, user-facing description of the same set —
 * what powers `/orchestrator/tools` and `GET /api/orchestrator/tools`.
 *
 * Drift policy: `llm_description` here MUST match the description string
 * passed to the `tool()` call in `index.ts`. `assertManifestParity()`
 * runs on first orchestrator dispatch and warns on mismatch. We accept
 * the duplication for V1 because extracting strings as exported consts
 * fragments the tool definition site (the description sits next to its
 * schema today, which is more readable). If drift becomes a recurring
 * problem, refactor to a shared-const layout.
 */

export type ToolCategory =
	| 'reply'
	| 'read' // webSearch, vaultSearch, youtubeFetch
	| 'write' // generateImage (writes a file), vaultSave (writes a note)
	| 'agent' // dispatchAgent (heavy specialist)
	| 'skill'; // invokeSkill (scoped utility)

export interface ToolConfigPointer {
	/** Settings JSON path the user can edit, e.g. `channels.whatsapp.youtube`. */
	settingsKey: string;
	/** Short label for the UI link, e.g. "WhatsApp → YouTube settings". */
	label: string;
}

export interface ToolExample {
	/** When the user might say something like... */
	user: string;
	/** ...the model picks this tool with these args. */
	toolArgs: string;
}

export interface ToolManifest {
	/** Tool name as registered in `buildOrchestratorTools()`. Matches the
	 *  key the AI SDK will report in step.toolCalls. */
	name: string;
	category: ToolCategory;
	/** What the LLM sees in the tool description. MUST match the string
	 *  passed to `tool({ description, ... })` in index.ts. */
	llm_description: string;
	/** Short, user-facing one-liner for the /orchestrator/tools page list.
	 *  Plain language, no model-prompt-engineering. */
	ui_description: string;
	/** Pointer to a settings panel for tools whose behavior the user can
	 *  tune (e.g. youtube cap). Undefined when the tool has no knobs. */
	has_config?: ToolConfigPointer;
	/** Optional usage examples — surfaced in the row's expanded view. */
	examples?: ToolExample[];
}

export const TOOL_MANIFESTS: ToolManifest[] = [
	{
		name: 'reply',
		category: 'reply',
		llm_description:
			'Reply to the user with a chat message. Use for greetings, conversation, quick known facts, follow-up summaries, or asking a clarification. NOT for unknown facts (use webSearch) or vault lookups (use vaultSearch).',
		ui_description:
			'Send a chat message back. The default conversation tool — picked for greetings, clarifications, and known-fact replies.',
	},
	{
		name: 'webSearch',
		category: 'read',
		llm_description:
			"Quick Gemini-grounded Google Search for current real-world facts (weather, news, today's score, single lookups). Returns chat-formatted answer with one source URL. When the user names a specific source (e.g. \"Khaleej Times\", \"The National\", \"Reuters\"), shape the query as `site:<domain> <topic>` — e.g. `site:khaleejtimes.com today's UAE headlines` — so grounding pulls from that source instead of a broad mix.",
		ui_description:
			'Quick web search via Gemini-grounded Google Search. Used for current facts (weather, news, scores) with a citation URL.',
		examples: [
			{ user: '"weather in Dubai today"', toolArgs: '{ query: "weather in Dubai today" }' },
			{
				user: '"latest from Khaleej Times"',
				toolArgs: '{ query: "site:khaleejtimes.com latest UAE news" }',
			},
		],
	},
	{
		name: 'vaultSearch',
		category: 'read',
		llm_description:
			'Search the user\'s Obsidian vault for the user\'s OWN saved notes. Use for "do we have research on X", "what did we save about Y", "find my notes on Z", "did I write anything about W". Do NOT use for current events, news, headlines, weather, live scores, or any question about the outside world — those go to webSearch. Vault returning a topic-adjacent note does not satisfy a news / current-events question.',
		ui_description:
			'Search the user\'s Obsidian vault notes (lexical / MiniSearch). Used for "do we have notes on..." style questions.',
		examples: [
			{ user: '"what did we save about hydroponics"', toolArgs: '{ query: "hydroponics" }' },
		],
	},
	{
		name: 'generateImage',
		category: 'write',
		llm_description:
			'Generate a single text-to-image via Gemini Nano Banana. Use ONLY for "make me a picture of X" with NO text overlay, NO video, NO voiceover, NO carousel, NO Arabic text. If the user wants any of those, use dispatchAgent with agentId="media-generator".',
		ui_description:
			'Generate one text-to-image via Gemini Nano Banana. No text overlay, no video, no Arabic text — those go to media-generator agent.',
		has_config: {
			settingsKey: 'channels.whatsapp.img',
			label: 'WhatsApp → Image generation settings',
		},
		examples: [
			{
				user: '"make me a picture of a sunset over Abu Dhabi"',
				toolArgs: '{ prompt: "a sunset over Abu Dhabi" }',
			},
		],
	},
	{
		name: 'dispatchAgent',
		category: 'agent',
		llm_description:
			'Dispatch a heavy specialist agent (runs minutes). OMIT confirmed (or set false) to PROPOSE the dispatch — the user replies "yes" to run it. Set confirmed=true ONLY when the user explicitly confirmed a prior proposal OR used an unambiguous command verb ("research X for me", "draft Y about Z", "review this code", "audit Q").',
		ui_description:
			'Dispatch a specialist agent (researcher, media-creator, etc.) — runs for minutes. Confirms with the user before firing unless the verb is unambiguous ("research X", "draft Y").',
	},
	{
		name: 'youtubeFetch',
		category: 'read',
		llm_description:
			'Fetch a YouTube video — title, channel, duration, thumbnail, and (when needed) transcript or summary. ' +
			'Use whenever the user shares a YouTube URL (youtube.com, youtu.be, share.google/...) — ' +
			'whether they want to save it, review it, summarize it, quote it, or ask a question about its content. ' +
			'Modes: "metadata" = title/channel/thumbnail only (instant, free, for save-shaped intents); ' +
			'"summary" = adds a 2-3 paragraph summary via Gemini (~10-25s, costs cents — for review/summarize/quote intents); ' +
			'"transcript" = adds the full transcript text (~25s, costs cents — for "what does he say about X" intents); ' +
			'"full" = metadata + summary + transcript in one call. ' +
			'After the tool returns, compose your reply from the structured fields. ' +
			'If the result has note="transcript-quota-exceeded" or note="gemini-failed", tell the user we have the title and thumbnail but couldn\'t analyze the video this turn.',
		ui_description:
			'Fetch a YouTube video: oEmbed for metadata + Gemini multimodal for transcript/summary. Capped per day to bound cost.',
		has_config: {
			settingsKey: 'channels.whatsapp.youtube',
			label: 'WhatsApp → YouTube fetch settings',
		},
		examples: [
			{ user: '"summarize this video <yt url>"', toolArgs: '{ url: "...", mode: "summary" }' },
			{
				user: '"save this for me <yt url>"',
				toolArgs: '{ url: "...", mode: "metadata" }',
			},
		],
	},
	{
		name: 'tiktokFetch',
		category: 'read',
		llm_description:
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
		ui_description:
			'Fetch a TikTok video: yt-dlp metadata + local whisper.cpp transcript + optional Gemini summary. Tool is dropped from the registry on hosts missing yt-dlp/ffmpeg/whisper-cli — install via `npm run setup -- --with-tiktok`.',
		has_config: {
			settingsKey: 'channels.whatsapp.tiktok',
			label: 'WhatsApp → TikTok fetch settings',
		},
		examples: [
			{ user: '"what does this TikTok say <url>"', toolArgs: '{ url: "...", mode: "transcript" }' },
			{
				user: '"save this TikTok <url>"',
				toolArgs: '{ url: "...", mode: "metadata" }',
			},
			{
				user: '"summarize this TikTok <url>"',
				toolArgs: '{ url: "...", mode: "summary" }',
			},
		],
	},
	{
		name: 'vaultSave',
		category: 'write',
		llm_description:
			"Save composed content to the user's Obsidian vault as a markdown note. " +
			'Use ONLY when the user explicitly asks to save / capture / remember / add to notes / write down / store. ' +
			'NEVER call this for discussion-only requests. ' +
			'For multi-step flows (e.g. user asks to save a YouTube video), call the upstream tool first ' +
			'(youtubeFetch with mode=summary), then synthesize a clean note body, THEN call vaultSave with the ' +
			'synthesized title + body. ' +
			'Always writes to the inbox zone — the user curates from there. After it returns, include the openUrl ' +
			'in your reply so the user can open the note.',
		ui_description:
			'Save a composed note to the vault inbox/. Triggered only by explicit save phrasings; used in chains like "summarize this video and save it".',
		examples: [
			{
				user: '"save this idea: bilingual newsletter MVP"',
				toolArgs:
					'{ title: "Bilingual newsletter MVP", content: "...", type: "idea", tags: ["mvp"] }',
			},
		],
	},
	{
		name: 'invokeSkill',
		category: 'skill',
		llm_description:
			'Invoke a Claude Skill — fast scoped utility (seconds, not minutes). Prefer this over dispatchAgent for narrow tasks. Skills run synchronously and the output is threaded back to you so you can compose the final reply.',
		ui_description:
			'Invoke a chat-enabled skill (research, recipe, arabic, etc.). Synchronous, seconds. Skill list is dynamic — see /orchestration/skills.',
	},
	{
		name: 'inbox-list-queued',
		category: 'read',
		llm_description:
			"List the user's queued inbox messages (post-Layer-2 filter, agent-relevant only). " +
			"Use when the user asks 'what's in my inbox', 'any new emails', 'show me bank alerts', 'what came in today'. " +
			"Filter by category for targeted queries: personal (human mail), transactional (bank/orders/receipts), notification (service alerts), unclassified (filter wasn't confident). " +
			"Returns newest first.",
		ui_description:
			'List queued inbox messages, optionally filtered by category. The queued stream is what Layer 2 deemed agent-relevant.',
		examples: [
			{ user: '"any new emails today"', toolArgs: '{ since: "today", limit: 10 }' },
			{ user: '"show me my bank alerts"', toolArgs: '{ category: "transactional", limit: 5 }' },
		],
	},
	{
		name: 'inbox-mark-processed',
		category: 'write',
		llm_description:
			"Mark an inbox message as processed (agent has handled it). The message transitions queued → processed; it stays cached for 365 days as audit trail but stops appearing in queued listings. " +
			"Use after summarizing, routing-to-vault, replying, or otherwise handling a message.",
		ui_description:
			'Mark a queued inbox message as processed. Agents call this after handling.',
	},
	{
		name: 'inbox-correct-classification',
		category: 'write',
		llm_description:
			"Correct the Layer 2 classification of a message and update the cache so future similar messages get the new category. " +
			"Use when the user pushes back (\"that's not promotional, it's a receipt\") or when the agent notices a clear miscategorization. " +
			"Scope can be 'this' (this message only) or 'pattern' (this message + all matching siblings via the cache signature).",
		ui_description:
			'Correct a misclassified inbox message and update the cache so future similar messages get the right category.',
	},
	{
		name: 'inbox-read-body',
		category: 'read',
		llm_description:
			"Fetch the full body text of a queued inbox message. " +
			"Use ONLY after inbox-list-queued returned a row whose preview is insufficient to answer the user's question. " +
			"Bodies are fetched live from IMAP each call — not cached server-side. " +
			"Avoid for routine 'what's in my inbox' queries; preview is usually enough. " +
			"Required for 'what did X say', 'what was the amount', 'extract the link from row N'.",
		ui_description:
			'Fetch the full body of a queued inbox message live from IMAP. Used when the preview is not enough to answer a follow-up question.',
		examples: [
			{
				user: '"what did the noon order email actually say"',
				toolArgs: '{ messageId: 32801 }',
			},
		],
	},
	{
		name: 'scheduleReminder',
		category: 'write',
		llm_description:
			'Schedule a one-time reminder for the user. ' +
			'Use ONLY when the user explicitly asks to be reminded ("remind me to X at Y", "ping me tomorrow about Z"). ' +
			'NEVER use for discussion ("do you remember when..."), vague intents ("I should probably do X someday"), or inferred follow-ups from the conversation. ' +
			'Emit `dueAt` as an ISO 8601 datetime WITH timezone offset — parse natural language ' +
			'("tomorrow 11am", "next Monday morning") relative to the user\'s timezone (Asia/Dubai unless context overrides). ' +
			'Reminders fire on the WhatsApp heartbeat (within ~30 min of the due time) and only inside the user\'s active hours. ' +
			'If the user names a time outside active hours (e.g. "remind me at 3 am"), the system defers to the start of the next active window — the tool result\'s `cadenceNote` tells you when it will actually fire so you can confirm honestly. ' +
			'Reminders are WhatsApp-only today (Telegram returns `reminders-not-supported-on-this-channel`). ' +
			'After the tool returns successfully, confirm to the user: "OK — I\'ll remind you about <text> on <date> around <time>" — include the cadenceNote when present.',
		ui_description:
			'Schedule a one-time reminder. Rides the WhatsApp heartbeat commitments rail (ADR-025) — fires within ~30 min of the due time during active hours; same `HEARTBEAT_OK <id>` dismissal contract as extractor-inferred follow-ups.',
		examples: [
			{
				user: '"remind me tomorrow to call my dad around 11am"',
				toolArgs: '{ text: "Call your dad", dueAt: "2026-05-12T11:00:00+04:00" }',
			},
		],
	},
];

/** Lookup helper. Returns undefined for unknown names so callers can
 *  decide between strict failure and graceful degrade. */
export function getToolManifest(name: string): ToolManifest | undefined {
	return TOOL_MANIFESTS.find((m) => m.name === name);
}

/** Stable category order for grouping in the UI — read-tools first
 *  (most common), then write, then orchestration (agent/skill), reply
 *  last (least interesting to surface). */
export const CATEGORY_ORDER: ToolCategory[] = ['read', 'write', 'agent', 'skill', 'reply'];

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
	read: 'Read',
	write: 'Write',
	agent: 'Dispatch agent',
	skill: 'Invoke skill',
	reply: 'Reply',
};
