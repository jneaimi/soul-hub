<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		prompt?: string;
		cwd?: string;
		autoSpawn?: boolean;
	}

	let { prompt = '', cwd = '', autoSpawn = false }: Props = $props();

	let terminalEl: HTMLDivElement | undefined = $state();
	let terminal: any = null;
	let fitAddon: any = null;
	let abortController: AbortController | null = null;
	let sessionId = $state('');
	let running = $state(false);
	let exitCode = $state<number | null>(null);
	let pid = $state<number | null>(null);
	let error = $state('');
	let isTouchDevice = $state(false);
	let ctrlActive = $state(false);
	let altActive = $state(false);

	// Send a key (or modified key) to the terminal
	function sendKey(key: string) {
		if (!sessionId || !running) return;

		let data = key;

		// Apply modifiers
		if (ctrlActive && key.length === 1) {
			// Ctrl+letter = char code 1-26
			const code = key.toUpperCase().charCodeAt(0) - 64;
			if (code >= 1 && code <= 26) data = String.fromCharCode(code);
			else data = key;
			ctrlActive = false;
		} else if (altActive) {
			data = '\x1b' + key;
			altActive = false;
		}

		sendInput(data);
	}

	function toggleCtrl() {
		ctrlActive = !ctrlActive;
		altActive = false;
	}

	function toggleAlt() {
		altActive = !altActive;
		ctrlActive = false;
	}

	// Wrapper for touch events — prevents default (no scroll/zoom) and sends key
	function xkey(key: string) {
		return (e: TouchEvent) => {
			e.preventDefault();
			sendKey(key);
		};
	}

	function xctrl(e: TouchEvent) {
		e.preventDefault();
		toggleCtrl();
	}

	function xalt(e: TouchEvent) {
		e.preventDefault();
		toggleAlt();
	}

	onMount(async () => {
		const { Terminal } = await import('@xterm/xterm');
		const { FitAddon } = await import('@xterm/addon-fit');
		const { WebLinksAddon } = await import('@xterm/addon-web-links');
		await import('@xterm/xterm/css/xterm.css');

		terminal = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
			theme: {
				background: '#0a0a0f',
				foreground: '#e0e0e8',
				cursor: '#a78bfa',
				selectionBackground: '#a78bfa40',
				black: '#1a1a2e',
				red: '#ff6b6b',
				green: '#51cf66',
				yellow: '#fcc419',
				blue: '#748ffc',
				magenta: '#c084fc',
				cyan: '#22d3ee',
				white: '#e0e0e8',
				brightBlack: '#4a4a6a',
				brightRed: '#ff8787',
				brightGreen: '#69db7c',
				brightYellow: '#ffd43b',
				brightBlue: '#91a7ff',
				brightMagenta: '#d8b4fe',
				brightCyan: '#67e8f9',
				brightWhite: '#f8f8ff',
			},
			allowProposedApi: true,
		});

		fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(new WebLinksAddon());

		if (terminalEl) {
			terminal.open(terminalEl);
			fitAddon.fit();
		}

		terminal.onData((data: string) => {
			if (sessionId && running) {
				sendInput(data);
			}
		});

		const resizeObserver = new ResizeObserver(() => {
			if (fitAddon && terminal) {
				fitAddon.fit();
				if (sessionId && running) {
					sendResize(terminal.cols, terminal.rows);
				}
			}
		});
		if (terminalEl) resizeObserver.observe(terminalEl);

		isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

		terminal.writeln('\x1b[38;5;141m  Soul Hub v2\x1b[0m');
		terminal.writeln('\x1b[38;5;245m  PTY Terminal\x1b[0m');
		terminal.writeln('');

		if (autoSpawn && prompt) spawn();

		return () => resizeObserver.disconnect();
	});

	onDestroy(() => {
		if (abortController) abortController.abort();
		if (sessionId) killSession();
		if (terminal) terminal.dispose();
	});

	async function sendInput(data: string) {
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'input', sessionId, data }),
			});
		} catch { /* best effort */ }
	}

	async function sendResize(cols: number, rows: number) {
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'resize', sessionId, cols, rows }),
			});
		} catch { /* best effort */ }
	}

	async function killSession() {
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'kill', sessionId }),
			});
		} catch { /* best effort */ }
	}

	export function spawn(customPrompt?: string) {
		const p = customPrompt || prompt;
		if (!p.trim()) return;

		error = '';
		exitCode = null;
		running = true;
		sessionId = '';

		terminal?.writeln(`\x1b[38;5;245m  Starting agent...\x1b[0m`);
		terminal?.focus();

		abortController = new AbortController();

		fetch('/api/pty', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'spawn',
				prompt: p,
				cwd: cwd || undefined,
				cols: terminal?.cols || 120,
				rows: terminal?.rows || 40,
			}),
			signal: abortController.signal,
		}).then(async (res) => {
			if (!res.ok || !res.body) {
				error = `Request failed: ${res.status}`;
				running = false;
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const raw = line.slice(6);
					if (raw === '[DONE]') continue;

					try {
						const msg = JSON.parse(raw);
						switch (msg.type) {
							case 'session':
								sessionId = msg.sessionId;
								break;
							case 'output':
								terminal?.write(msg.data);
								break;
							case 'spawned':
								pid = msg.pid;
								break;
							case 'exit':
								exitCode = msg.code;
								running = false;
								sessionId = '';
								terminal?.writeln('');
								terminal?.writeln(`\x1b[38;5;${msg.code === 0 ? '82' : '203'}m  Process exited (code ${msg.code})\x1b[0m`);
								break;
						}
					} catch { /* skip */ }
				}
			}

			if (running) {
				running = false;
				terminal?.writeln('\x1b[38;5;245m  Stream ended\x1b[0m');
			}
		}).catch((e) => {
			if (e.name !== 'AbortError') {
				error = e.message;
				running = false;
			}
		});
	}

	export function kill() {
		if (abortController) abortController.abort();
		if (sessionId) killSession();
		running = false;
		sessionId = '';
		terminal?.writeln('\x1b[38;5;203m  Killed by user\x1b[0m');
	}

	export function clear() {
		terminal?.clear();
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center justify-between px-3 py-2 bg-[#0a0a0f] border-b border-hub-border/50 text-xs">
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-1.5">
				<span class="w-2 h-2 rounded-full {running ? 'bg-green-400 animate-pulse' : exitCode !== null ? (exitCode === 0 ? 'bg-green-400' : 'bg-red-400') : 'bg-hub-dim'}"></span>
				<span class="text-hub-muted">
					{#if running}Running{:else if exitCode !== null}Done{:else}Ready{/if}
				</span>
			</div>
			{#if pid}
				<span class="text-hub-dim font-mono">PID {pid}</span>
			{/if}
			{#if exitCode !== null}
				<span class="font-mono {exitCode === 0 ? 'text-green-400' : 'text-red-400'}">exit {exitCode}</span>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if running}
				<button onclick={kill} class="px-2 py-1 rounded text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer">Kill</button>
			{/if}
			<button onclick={clear} class="px-2 py-1 rounded text-hub-muted hover:bg-hub-surface transition-colors cursor-pointer">Clear</button>
		</div>
	</div>

	<div bind:this={terminalEl} class="flex-1 min-h-0"></div>

	<!-- Mobile extra keys toolbar -->
	{#if isTouchDevice}
		<div class="flex-shrink-0 bg-[#0d0d14] border-t border-hub-border/50 select-none">
			<!-- Row 1: modifiers + special chars + Up arrow -->
			<div class="flex items-center px-1 pt-1 pb-0.5 gap-0.5">
				<button ontouchstart={xkey('\x1b')} class="xkey">ESC</button>
				<button ontouchstart={xkey('\t')} class="xkey">TAB</button>
				<button ontouchstart={xctrl} class="xkey {ctrlActive ? 'xkey-active' : ''}">CTL</button>
				<button ontouchstart={xalt} class="xkey {altActive ? 'xkey-active' : ''}">ALT</button>
				<button ontouchstart={xkey('/')} class="xkey">/</button>
				<button ontouchstart={xkey('-')} class="xkey">-</button>
				<button ontouchstart={xkey('_')} class="xkey">_</button>
				<button ontouchstart={xkey('~')} class="xkey">~</button>
				<div class="ml-auto flex gap-0.5">
					<div class="w-9"></div>
					<button ontouchstart={xkey('\x1b[A')} class="xkey xkey-arrow">&uarr;</button>
					<div class="w-9"></div>
				</div>
			</div>
			<!-- Row 2: more chars + Left/Down/Right arrows -->
			<div class="flex items-center px-1 pb-1 pt-0.5 gap-0.5">
				<button ontouchstart={xkey('|')} class="xkey">|</button>
				<button ontouchstart={xkey('*')} class="xkey">*</button>
				<button ontouchstart={xkey('{')} class="xkey">&#123;</button>
				<button ontouchstart={xkey('}')} class="xkey">&#125;</button>
				<button ontouchstart={xkey('\x1b[H')} class="xkey text-[9px]">HOM</button>
				<button ontouchstart={xkey('\x1b[F')} class="xkey text-[9px]">END</button>
				<button ontouchstart={xkey('\x1b[5~')} class="xkey text-[9px]">PU</button>
				<button ontouchstart={xkey('\x1b[6~')} class="xkey text-[9px]">PD</button>
				<div class="ml-auto flex gap-0.5">
					<button ontouchstart={xkey('\x1b[D')} class="xkey xkey-arrow">&larr;</button>
					<button ontouchstart={xkey('\x1b[B')} class="xkey xkey-arrow">&darr;</button>
					<button ontouchstart={xkey('\x1b[C')} class="xkey xkey-arrow">&rarr;</button>
				</div>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="px-3 py-2 bg-red-500/10 border-t border-red-500/30 text-xs text-red-400">
			{error}
		</div>
	{/if}
</div>
