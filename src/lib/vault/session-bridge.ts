import { getVaultEngine } from './index.js';
import { readLogTail, type SessionMeta } from '../pty/store.js';

/**
 * Save a completed PTY session as a vault note.
 * Non-blocking — errors are caught and logged.
 */
export async function captureSessionToVault(sessionId: string, meta: SessionMeta): Promise<void> {
  const engine = getVaultEngine();
  if (!engine) {
    console.warn('[vault/session] Engine not initialized — skipping session capture');
    return;
  }

  // Skip very short sessions (< 5 seconds or < 100 bytes logged)
  if (meta.logSize < 100) return;
  const startTime = new Date(meta.startedAt).getTime();
  const endTime = meta.endedAt ? new Date(meta.endedAt).getTime() : Date.now();
  if (endTime - startTime < 5000) return;

  try {
    // Read last portion of log (cap at 20KB to keep notes reasonable)
    const rawLog = readLogTail(sessionId, 20_000);
    // Strip ANSI escape codes for clean markdown
    const log = rawLog.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

    // Detect project from cwd (for tagging, not zone routing)
    const cwdParts = meta.cwd.split('/');
    const devIdx = cwdParts.indexOf('dev');
    const projectName = devIdx >= 0 && cwdParts[devIdx + 1] ? cwdParts[devIdx + 1] : null;

    // All sessions go to the dedicated sessions zone (auto-pruned after 7 days)
    const zone = 'sessions';

    // Generate filename
    const date = meta.startedAt.slice(0, 10);
    const shortId = sessionId.slice(0, 8);
    const filename = `${date}-session-${shortId}.md`;

    // Calculate duration
    const durationSec = Math.floor((endTime - startTime) / 1000);
    const durationStr = durationSec < 60 ? `${durationSec}s` :
      durationSec < 3600 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` :
      `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`;

    // Build content — link back to project so graph shows the connection
    let content = `# Session ${shortId}\n\n`;
    if (projectName) {
      content += `Part of [[projects/${projectName}/index|${projectName}]]\n\n`;
    }
    content += `## Context\n\n`;
    content += `- **Working Directory**: \`${meta.cwd}\`\n`;
    content += `- **Started**: ${meta.startedAt}\n`;
    if (meta.endedAt) content += `- **Ended**: ${meta.endedAt}\n`;
    content += `- **Duration**: ${durationStr}\n`;
    content += `- **Exit Code**: ${meta.exitCode ?? 'N/A'}\n`;
    content += `- **Log Size**: ${(meta.logSize / 1024).toFixed(1)} KB\n`;
    if (meta.prompt) {
      content += `\n**Initial Prompt**:\n\`\`\`\n${meta.prompt.slice(0, 500)}\n\`\`\`\n`;
    }
    content += `\n## Session Log (last ${Math.min(meta.logSize, 20000)} bytes)\n\n`;
    content += `\`\`\`\n${log}\n\`\`\`\n`;

    const tags = ['session'];
    if (projectName) tags.push(projectName);
    if (meta.exitCode != null && meta.exitCode !== 0) tags.push('error');

    const result = await engine.createNote({
      zone,
      filename,
      meta: {
        type: 'session-log',
        created: date,
        tags,
        project: projectName || undefined,
        session_id: sessionId,
        exit_code: meta.exitCode,
        duration_sec: durationSec,
      },
      content,
    });

    if (result.success) {
      console.log(`[vault/session] Captured: ${result.path}`);
    } else if ('error' in result) {
      console.log(`[vault/session] Skipped: ${result.error}`);
    }
  } catch (err) {
    console.error(`[vault/session] Failed:`, err instanceof Error ? err.message : err);
  }
}
