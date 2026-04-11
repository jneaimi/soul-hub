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

## Step 2: Configure Environment (Optional)

```bash
cp .env.example .env
```

Edit `.env` to add any API keys you need. All keys are optional — core features work without them.

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

If the path is different from the default (`~/.claude/bin/claude`), create a `settings.json`:

```bash
cat > settings.json << 'EOF'
{
  "paths": {
    "claudeBinary": "/path/to/your/claude"
  }
}
EOF
```

## Step 5: Run

### Development Mode

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Production Mode

```bash
# Build the app
npm run build

# Start with PM2
./scripts/start_prod.sh start
```

Open [http://localhost:2400](http://localhost:2400).

### Production Commands

```bash
./scripts/start_prod.sh start     # Build and start
./scripts/start_prod.sh stop      # Stop all processes
./scripts/start_prod.sh restart   # Rebuild and zero-downtime reload
./scripts/start_prod.sh status    # Show process status
./scripts/start_prod.sh logs      # Tail logs
./scripts/start_prod.sh startup   # Enable auto-start on boot
```

## Configuration Reference

Soul Hub reads `settings.json` from the project root. All fields are optional — defaults are shown below:

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
