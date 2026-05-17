import { apiGet, baseUrl, ApiError } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface DoctorReport {
  ok: boolean;
  baseUrl: string;
  api: { reachable: boolean; status?: number | string };
  cli: { version: string; path: string };
  hooks: { writeGuard: boolean; bashGuard: boolean; vaultWriteSkill: boolean };
  notes: string[];
}

function pkgVersion(): string {
  try {
    const p = join(import.meta.dirname ?? '', '..', '..', 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version ?? '?';
  } catch {}
  return '?';
}

export async function doctor(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const report: DoctorReport = {
    ok: true,
    baseUrl: baseUrl(),
    api: { reachable: false },
    cli: { version: pkgVersion(), path: process.argv[1] ?? '?' },
    hooks: {
      writeGuard: existsSync(join(homedir(), '.claude/hooks/vault-write-guard.sh')),
      bashGuard: existsSync(join(homedir(), '.claude/hooks/vault-write-guard-bash.sh')),
      vaultWriteSkill: existsSync(join(homedir(), '.claude/skills/vault-write/SKILL.md')),
    },
    notes: [],
  };

  try {
    await apiGet('/api/system/health');
    report.api = { reachable: true, status: 'ok' };
  } catch (err) {
    report.api = {
      reachable: false,
      status: err instanceof ApiError ? err.status : 'network-error',
    };
    report.ok = false;
    report.notes.push(`API unreachable at ${baseUrl()} — start soul-hub (\`pnpm prod:start\` or \`npm run dev\`).`);
  }

  if (!report.hooks.writeGuard || !report.hooks.bashGuard) {
    report.notes.push('Vault write-guard hook(s) missing — run `bash install/install-chokepoint.sh` from soul-hub.');
  }
  if (!report.hooks.vaultWriteSkill) {
    report.notes.push('/vault-write skill missing — run `bash install/install-chokepoint.sh`.');
  }
  if (!report.api.reachable || !report.hooks.writeGuard) report.ok = false;

  emit(report, opts, (r: DoctorReport) => {
    const lines: string[] = [];
    lines.push(`soul ${r.cli.version}  ${r.cli.path}`);
    lines.push(`Base: ${r.baseUrl}`);
    lines.push(`API:  ${r.api.reachable ? '✓ reachable' : `✗ ${r.api.status}`}`);
    lines.push(`Hooks:`);
    lines.push(`  vault-write-guard.sh       ${r.hooks.writeGuard ? '✓' : '✗'}`);
    lines.push(`  vault-write-guard-bash.sh  ${r.hooks.bashGuard ? '✓' : '✗'}`);
    lines.push(`  /vault-write skill         ${r.hooks.vaultWriteSkill ? '✓' : '✗'}`);
    if (r.notes.length > 0) {
      lines.push('');
      lines.push('Notes:');
      for (const n of r.notes) lines.push(`  - ${n}`);
    }
    lines.push('');
    lines.push(r.ok ? '✓ doctor: ok' : '✗ doctor: issues found');
    return lines.join('\n');
  });

  if (!report.ok) process.exit(1);
}
