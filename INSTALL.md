# Installation Guide

## Prerequisites

| Requirement | Version | Required | Install |
|------------|---------|----------|---------|
| **Node.js** | 20+ | Yes | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **npm** | 10+ | Yes | Comes with Node.js |
| **Git** | 2.30+ | Yes | `brew install git` or `apt install git` |
| **Claude Code** | Latest | Yes | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code) |
| **uv** | Latest | For Python pipelines | [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) |
| **PM2** | 5+ | For production | Included as dev dependency |

### Supported Platforms

- **macOS** (Intel + Apple Silicon)
- **Linux** (Ubuntu 20.04+, Debian 11+, Fedora 38+)

Windows is not currently supported due to PTY and shell dependencies.

## Step 1: Clone and Install

```bash
git clone https://github.com/jneaimi/soul-hub.git
cd soul-hub
npm install
```

> **Note:** `npm install` will compile the `node-pty` native module. This requires build tools:
> - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
> - **Linux**: `sudo apt install build-essential python3` (Debian/Ubuntu) or `sudo dnf groupinstall "Development Tools"` (Fedora)

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Most variables in `.env` are optional — core features work without them. The one exception is `SOUL_HUB_SECRET`, which is required if you plan to use the **Unified Inbox** (the email aggregator encrypts stored credentials with this key).

Generate one and append it to `.env`:

```bash
echo "SOUL_HUB_SECRET=$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))')" >> .env
```

> Keep this value safe — losing it makes any existing encrypted inbox credentials unrecoverable.

Edit `.env` to add any API keys you need (Gemini, ElevenLabs, Telegram, etc.). Pipelines that require a specific key will fail gracefully if it's missing.

### Optional — Mac-wide secret store (recommended)

Soul Hub stores platform secrets in `~/.soul-hub/.env` (managed via the Settings UI). To make those same secrets visible to your shell and any tool you run from it, add this one line near the bottom of `~/.zshrc` (or `~/.bashrc`):

```bash
set -a; [ -f "$HOME/.soul-hub/.env" ] && . "$HOME/.soul-hub/.env"; set +a
```

`set -a` exports every variable defined in the file. The `[ -f ... ]` check makes the line a no-op for fresh installs that don't have the file yet. The PM2 config already reads the same file via `env_file`, so child processes spawned by Soul Hub inherit it without the zshrc line — this is just for shell sessions and other tools.

#### launchd cron jobs (advanced)

If you have personal launchd jobs (cron-style background tasks under `~/Library/LaunchAgents/com.*.plist`) that should also see your Soul Hub secrets, wrap their `ProgramArguments` with a `/bin/sh -c` preamble that sources the env file before `exec`-ing the original command:

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; [ -f "$HOME/.soul-hub/.env" ] &amp;&amp; . "$HOME/.soul-hub/.env"; set +a; exec /opt/homebrew/bin/python3 /Users/you/path/to/script.py</string>
</array>
```

Apply with `launchctl bootout gui/$(id -u)/<label> && launchctl bootstrap gui/$(id -u) <plist>`.

#### Diagnose drift

Run the doctor any time to verify all entry points see the same secrets:

```bash
./scripts/doctor-secrets.sh
```

It checks `~/.soul-hub/` modes, the secrets file, the zshrc source line, the PM2 `env_file` declaration, and any user-owned launchd plists. Read-only — never modifies anything. Exits non-zero on FAIL so it can be wired into CI later.

#### Test individual credentials from the UI

Settings → **Platform Environment** renders a **Test** button next to every declared + set credential. Clicking it pings the upstream API with a read-only request and colour-codes the row by outcome (`ok`, `unauthorized`, `invalid`, `ratelimit`, `network`, `unconfigured`, `unsupported`). Built-in coverage:

| Key | What's tested |
|---|---|
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot token via `getMe`, chat reachability via `getChat` |
| `GEMINI_API_KEY` | `GET /v1beta/models` |
| `OPENROUTER_API_KEY` | `GET /api/v1/auth/key` |
| `ANTHROPIC_API_KEY` | `GET /v1/models` |
| `ELEVENLABS_API_KEY` | `GET /v1/user` |
| `RESEND_API_KEY` | `GET /api-keys` |
| `YOUTUBE_API_KEY` | `videos.list` (zero quota cost) |
| `LINEAR_API_KEY` | GraphQL `viewer { id }` |
| `HF_API_TOKEN` | `whoami-v2` |
| `GOOGLE_API_KEY` | Geocoding API ping |
| `EODHD_API_KEY` | `user` endpoint |

Add a tester for a new provider by dropping a file in `src/lib/providers/` that exports `provider: ProviderTester` and registering it in `providers/registry.ts`.

#### Test routes from the UI

Settings → **Routes** lists every configured route (primary + failover chain + timeout + retries + live circuit-breaker state) and exposes a per-route **Test** button that runs a small ping through `dispatchRoute()` and reports which provider answered, the latency, and a short transcript snippet. Useful for verifying that a route's failover chain actually fails over — flipping a credential and re-testing instantly shows the next-in-chain taking over.

#### WhatsApp pairing without leaving the browser

Settings → **WhatsApp** carries the full lifecycle: a Link button that triggers `/login` and renders the QR inline (polling for refresh while pairing), allowlist editor, intent map editor (slash commands → routes), and the worker-mode toggle for the crash-isolated PM2 app. Status updates poll fast (1.5s) while pairing and slow (8s) while idle.

## Step 3: Initialize the Vault

Create the vault directory where your knowledge will be stored:

```bash
mkdir -p ~/vault
```

The vault will auto-initialize with governance files and templates on first access.

## Step 4: Find Your Claude Binary

Soul Hub needs to know where Claude Code is installed:

```bash
which claude
```

If the path is different from the default (`~/.local/bin/claude`), copy the provided example settings to your Soul Hub home directory and edit:

```bash
mkdir -p ~/.soul-hub
cp settings.example.json ~/.soul-hub/settings.json
# Then edit ~/.soul-hub/settings.json and update paths.claudeBinary to match `which claude`
```

Soul Hub stores all user state outside the repo under `~/.soul-hub/` (settings, secrets, runtime data, logs). Override the location by exporting `SOUL_HUB_HOME` if you need to. All paths support `~` expansion.

## Step 5: Run

### Development Mode

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Production Mode (PM2)

```bash
# Build the app
npm run build

# Start with PM2 (runs on port 2400)
npm run prod:start
```

Open [http://localhost:2400](http://localhost:2400).

### Production Commands

```bash
npm run prod:start      # Start all processes (app + tunnel)
npm run prod:stop       # Stop all processes
npm run prod:restart    # Zero-downtime reload
npm run prod:status     # Show process status
npm run prod:logs       # Tail logs
npm run prod:startup    # Enable auto-start on boot
```

The PM2 config is in `ecosystem.config.cjs`. It runs two processes:

| Process | Purpose | Port |
|---------|---------|------|
| `soul-hub` | SvelteKit app | 2400 |
| `soul-hub-tunnel` | Cloudflare Tunnel (optional) | - |

Logs are written to `~/.soul-hub/logs/`. The app auto-restarts on crash with exponential backoff, and respects a 512MB memory limit.

## Optional: Linking a WhatsApp Channel

Soul Hub can connect to a personal WhatsApp number via Baileys (unofficial WhatsApp Web library — use a dedicated number to stay clear of Meta's ToS gray zone). Once linked, inbound DMs route through the configurable routes layer (text chat goes to Gemini/OpenRouter/Anthropic; voice notes auto-transcribe via Gemini).

1. **Enable in `~/.soul-hub/settings.json`** — set `channels.whatsapp.enabled: true` and add your own number to the allowlist:

   ```json
   {
     "channels": {
       "whatsapp": {
         "enabled": true,
         "access": { "allowFrom": ["+9715xxxxxxxx"] }
       }
     }
   }
   ```

2. **Trigger pairing** — `curl -X POST http://localhost:2400/api/channels/whatsapp/login`. The QR appears two ways:
   - PNG data URL on `GET /api/channels/whatsapp/status` (rendered in the Settings UI when Phase 5 ships)
   - ANSI block-art QR printed to PM2 stdout (`npm run prod:logs`) when `delivery.printTerminalQr: true` (default)

3. **Scan with the WhatsApp app** → Settings → Linked Devices → Link a Device.

4. **Use it.** Free-form DMs route to `vault-chat`. Voice notes are transcribed and routed the same way. Slash commands map via `intentMap` (`/translate` ships by default → `translate-arabic`). Send a one-off message from code with `sendViaChannel('whatsapp', text, attachPath?)`.

Disconnect with `POST /api/channels/whatsapp/logout` (wipes the auth dir at `~/.soul-hub/data/whatsapp/<account>/` so the next login asks for a fresh QR).

### Crash-isolated worker mode (recommended for prod)

By default WhatsApp runs in-process inside the main `soul-hub` SvelteKit server — simple, but a Baileys WS error or decryption blowup takes the whole web UI with it. To isolate the channel, flip on the dedicated PM2 app `soul-hub-whatsapp`:

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "worker": {
        "enabled": true,
        "url": "http://127.0.0.1:2401",
        "mainAppUrl": "http://127.0.0.1:2400"
      }
    }
  }
}
```

Then `npm run prod:start` (or `npm run prod:restart`) — PM2 launches `soul-hub-whatsapp` alongside the main app. The main app's WhatsApp adapter switches to HTTP-proxy mode automatically; `/api/channels/whatsapp/{login,status,logout}` keep the same surface. Inbound messages flow back via a callback to `/api/channels/whatsapp/_inbound`. If the worker crashes, only the worker restarts — the SvelteKit server keeps serving.

For non-loopback setups (workers on a different host, or anyone exposing port 2401), set `channels.whatsapp.worker.bearerToken` to a shared secret. Both ends will then require `Authorization: Bearer <token>` on every request.

The worker is bundled into `build/whatsapp-worker.js` by `npm run build`. PM2's `whatsapp-out.log` / `whatsapp-error.log` (under `~/.soul-hub/logs/`) carry its output, including the ASCII pairing QR.

## Configuration Reference

Soul Hub reads `~/.soul-hub/settings.json`. All fields are optional — defaults are shown below:

```json
{
  "terminal": {
    "fontSize": 13,
    "cols": 120,
    "rows": 40,
    "cursorBlink": true
  },
  "interface": {
    "defaultPanel": "code",
    "panelWidth": 260
  },
  "paths": {
    "devDir": "~/dev",
    "vaultDir": "~/vault",
    "catalogDir": "~/dev/soul-hub/catalog",
    "claudeBinary": "~/.local/bin/claude"
  },
  "server": {
    "port": 2400
  },
  "proxy": {
    "enabled": true,
    "allowedPortRange": [1024, 9999],
    "blockedPorts": [2400]
  }
}
```

### Path Resolution

All paths support `~` expansion to your home directory. You can also use absolute paths.

| Path | Default | Purpose |
|------|---------|---------|
| `devDir` | `~/dev` | Where your projects live |
| `vaultDir` | `~/vault` | Knowledge vault (Obsidian-compatible) |
| `catalogDir` | `~/dev/soul-hub/catalog` | Shared blocks and agents |
| `claudeBinary` | `~/.local/bin/claude` | Claude Code CLI binary |

## Setting Up Your First Project

1. Open Soul Hub in your browser
2. Go to the **Projects** page
3. Click **Add Project** on any detected project in `~/dev/`
4. Open the project to launch a Claude Code terminal

## Creating Your First Pipeline

1. Go to the **Pipelines** page
2. Create a new folder in `pipelines/`:
   ```bash
   mkdir -p pipelines/my-pipeline/blocks/my-block
   ```
3. Or use the builder from within a Claude Code session in the `_builder` project

## Remote Access (Optional)

You can access Soul Hub remotely from any device using a Cloudflare Tunnel. This gives you:
- HTTPS access at `soul-hub.yourdomain.com`
- Dev preview proxy at `pXXXX.soul-hub.yourdomain.com`
- Optional email/SSO authentication via Cloudflare Access

See the full setup guide with screenshots: **[docs/tunnel-guide/TUNNEL.md](docs/tunnel-guide/TUNNEL.md)**

## Troubleshooting

### node-pty build fails

```bash
# macOS
xcode-select --install

# Linux (Debian/Ubuntu)
sudo apt install build-essential python3

# Then retry
npm rebuild node-pty
```

### Claude binary not found

Check where Claude Code is installed:
```bash
which claude
```

Update `settings.json` with the correct path.

### Port 2400 already in use

Change the port in `settings.json`:
```json
{ "server": { "port": 3000 } }
```

And set the `PORT` environment variable:
```bash
PORT=3000 npm run dev
```

### Vault not loading

Ensure the vault directory exists and is writable:
```bash
mkdir -p ~/vault
ls -la ~/vault
```

### Pipeline Python blocks fail

Install uv for Python dependency management:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### GitNexus analyze crashes on install

On Node 24 + npm 11, the stable `gitnexus@1.6.2` may fail during install with:

```
npm error Cannot destructure property 'package' of 'node.target' as it is null.
```

This is an npm arborist bug triggered by GitNexus's `tree-sitter-dart` git dependency. Use the 1.6.3 prerelease until it lands stable:

```bash
npx gitnexus@1.6.3-rc.28 analyze
```
