import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface BackgroundAgentInfo {
  id: string;
  sessionId: string;
  status?: string;
  state?: string;
}

/**
 * Live (not-yet-stopped) `claude --bg` agents for this workspace, keyed by sessionId so callers
 * can cross-reference against our own session list. Fails to an empty map on any error (`claude`
 * missing from PATH, agents subsystem unavailable, malformed output) — this is a pure enhancement,
 * never a hard dependency for listing/opening/deleting sessions.
 */
export async function listRunningBackgroundAgents(cwd: string): Promise<Map<string, BackgroundAgentInfo>> {
  const byId = new Map<string, BackgroundAgentInfo>();

  try {
    const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], { cwd });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return byId;
    }

    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const isLiveBackgroundAgent =
          e.kind === 'background' && e.state !== 'stopped' && typeof e.sessionId === 'string' && typeof e.id === 'string' && e.cwd === cwd;
        if (isLiveBackgroundAgent) {
          byId.set(e.sessionId as string, {
            id: e.id as string,
            sessionId: e.sessionId as string,
            status: typeof e.status === 'string' ? e.status : undefined,
            state: typeof e.state === 'string' ? e.state : undefined,
          });
        }
      }
    }
  } catch {
    // treated as "no background agents running" — see doc comment above
  }

  return byId;
}

export async function stopBackgroundAgent(id: string): Promise<void> {
  await execFileAsync('claude', ['stop', id]);
}

/** Used from archive/delete: a deliberate "I'm done with this" action should also free the background
 * agent, but must never block or fail the archive/delete itself if stopping it doesn't work out. */
export async function stopBackgroundAgentSafely(id: string, output: vscode.OutputChannel): Promise<void> {
  try {
    await stopBackgroundAgent(id);
    output.appendLine(`Stopped background agent ${id}`);
  } catch (err) {
    output.appendLine(`Could not stop background agent ${id}: ${String(err)}`);
  }
}
