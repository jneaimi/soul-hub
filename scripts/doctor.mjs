#!/usr/bin/env node
// Soul Hub health check. Cross-platform. Read-only.
// Run after bootstrap, or any time something feels off.

import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

const checks = [];
const add = (label, status, detail) => checks.push({ label, status, detail });

const HOME = homedir();
const SOUL_HUB_HOME = process.env.SOUL_HUB_HOME
  ? resolve(process.env.SOUL_HUB_HOME.replace(/^~/, HOME))
  : join(HOME, '.soul-hub');

console.log(bold('Soul Hub doctor'));
console.log(dim(`platform: ${platform()}  home: ${SOUL_HUB_HOME}`));
console.log();

// ── 1. Node version ────────────────────────────────────────────
{
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) add('Node.js', 'ok', `v${process.versions.node}`);
  else add('Node.js', 'fail', `v${process.versions.node} — need 20+`);
}

// ── 2. node-pty loads ──────────────────────────────────────────
try {
  const { default: pty } = await import('node-pty');
  if (typeof pty.spawn !== 'function') throw new Error('spawn() missing');
  add('node-pty', 'ok', 'loads');
} catch (e) {
  add('node-pty', 'fail', e.message.split('\n')[0]);
}

// ── 3. better-sqlite3 loads ────────────────────────────────────
try {
  const Database = (await import('better-sqlite3')).default;
  const tmp = new Database(':memory:');
  tmp.exec('CREATE TABLE t (n INTEGER)');
  tmp.close();
  add('better-sqlite3', 'ok', 'opens in-memory db');
} catch (e) {
  add('better-sqlite3', 'fail', e.message.split('\n')[0]);
}

// ── 4. ~/.soul-hub writable ────────────────────────────────────
try {
  if (!existsSync(SOUL_HUB_HOME)) {
    add('~/.soul-hub', 'fail', `missing — run: bash scripts/bootstrap.sh`);
  } else {
    accessSync(SOUL_HUB_HOME, constants.W_OK);
    add('~/.soul-hub', 'ok', SOUL_HUB_HOME);
  }
} catch {
  add('~/.soul-hub', 'fail', `not writable: ${SOUL_HUB_HOME}`);
}

// ── 5. settings.json ───────────────────────────────────────────
const SETTINGS = join(SOUL_HUB_HOME, 'settings.json');
let settings = null;
try {
  if (!existsSync(SETTINGS)) {
    add('settings.json', 'fail', `missing at ${SETTINGS}`);
  } else {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    add('settings.json', 'ok', SETTINGS);
  }
} catch (e) {
  add('settings.json', 'fail', `invalid JSON: ${e.message}`);
}

// ── 6. SOUL_HUB_SECRET ─────────────────────────────────────────
{
  const envFile = join(SOUL_HUB_HOME, '.env');
  let hasSecret = false;
  if (process.env.SOUL_HUB_SECRET) hasSecret = true;
  else if (existsSync(envFile)) {
    hasSecret = readFileSync(envFile, 'utf8').split(/\r?\n/).some((l) => /^SOUL_HUB_SECRET=.+/.test(l));
  }
  if (hasSecret) add('SOUL_HUB_SECRET', 'ok', 'present');
  else add('SOUL_HUB_SECRET', 'warn', 'unset — required for Unified Inbox only');
}

// ── 7. Vault dir ──────────────────────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const vaultDir = expand(settings?.paths?.vaultDir) || join(HOME, 'vault');
  if (existsSync(vaultDir)) {
    try {
      accessSync(vaultDir, constants.W_OK);
      add('vault dir', 'ok', vaultDir);
    } catch {
      add('vault dir', 'fail', `not writable: ${vaultDir}`);
    }
  } else {
    add('vault dir', 'warn', `missing: ${vaultDir} — created on first vault access`);
  }
}

// ── 8. Claude CLI ──────────────────────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const configured = expand(settings?.paths?.claudeBinary);
  let resolved = null;

  if (configured && existsSync(configured)) resolved = configured;
  else {
    try {
      const probe = platform() === 'win32' ? 'where claude' : 'command -v claude';
      resolved = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    } catch {
      resolved = null;
    }
  }

  if (resolved) add('claude CLI', 'ok', resolved);
  else add('claude CLI', 'fail', 'not found — install + set paths.claudeBinary in settings.json');
}

// ── 9. ~/.claude/CLAUDE.md vault block ─────────────────────────
{
  const claudeMd = join(HOME, '.claude', 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    add('CLAUDE.md', 'warn', `missing — run: npm run setup`);
  } else {
    const txt = readFileSync(claudeMd, 'utf8');
    if (txt.includes('<!-- soul-hub:start -->') && txt.includes('<!-- soul-hub:end -->')) {
      add('CLAUDE.md', 'ok', 'soul-hub block present');
    } else {
      add('CLAUDE.md', 'warn', `no soul-hub block — run: npm run setup`);
    }
  }
}

// ── 10. Vault git history (ADR-019) ────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const vaultDir = expand(settings?.paths?.vaultDir) || join(HOME, 'vault');
  const gitDir = join(vaultDir, '.git');
  if (!existsSync(vaultDir)) {
    add('vault git', 'warn', 'vault dir missing — run: bash scripts/bootstrap.sh');
  } else if (!existsSync(gitDir)) {
    add('vault git', 'warn', `${gitDir} missing — run: bash scripts/bootstrap.sh (re-run is idempotent)`);
  } else {
    try {
      const sha = execSync(`git -C "${vaultDir}" rev-parse HEAD`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      add('vault git', 'ok', `HEAD ${sha.slice(0, 7)}`);
    } catch {
      add('vault git', 'warn', 'repo initialized but no commits — set git config user.{name,email} and re-run setup');
    }
  }
}

// ── 11. vault-backup-daily scheduler task (ADR-019) ────────────
{
  const tasks = settings?.scheduler?.tasks ?? [];
  const found = Array.isArray(tasks) && tasks.some((t) => t?.id === 'vault-backup-daily');
  if (found) add('vault-backup task', 'ok', 'scheduler task registered');
  else add('vault-backup task', 'warn', 'not in settings.json — re-run: bash scripts/bootstrap.sh, or copy from settings.example.json');
}

// ── 12. Platform sanity ────────────────────────────────────────
if (platform() === 'win32') {
  add('platform', 'fail', 'native Windows is unsupported. Use WSL2 (Ubuntu). See INSTALL.md.');
} else if (platform() === 'linux') {
  // Detect WSL — informational only
  try {
    const v = readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(v)) add('platform', 'ok', 'Linux (WSL2)');
    else add('platform', 'ok', 'Linux');
  } catch {
    add('platform', 'ok', 'Linux');
  }
} else {
  add('platform', 'ok', platform());
}

// ── render ─────────────────────────────────────────────────────
const labelW = Math.max(...checks.map((c) => c.label.length));
let failed = 0;
let warned = 0;
for (const ch of checks) {
  const pad = ch.label.padEnd(labelW);
  const tag = ch.status === 'ok' ? green('  OK  ') : ch.status === 'warn' ? yellow(' WARN ') : red(' FAIL ');
  console.log(`  ${tag}  ${pad}  ${dim(ch.detail)}`);
  if (ch.status === 'fail') failed++;
  if (ch.status === 'warn') warned++;
}
console.log();
if (failed) {
  console.log(red(bold(`${failed} failed`)) + (warned ? `, ${yellow(`${warned} warning${warned > 1 ? 's' : ''}`)}` : ''));
  process.exit(1);
}
console.log(green(bold('All checks passed.')) + (warned ? `  (${yellow(`${warned} warning${warned > 1 ? 's' : ''}`)})` : ''));
