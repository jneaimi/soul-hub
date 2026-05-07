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
