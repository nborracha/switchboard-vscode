import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { claudeHome } from './sessionStore';

export interface LiveSessionEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
}

/** One `~/.claude/sessions/<pid>.json` file, as the CLI writes it for every running process. */
export function parseLiveSessionEntry(raw: string): LiveSessionEntry | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pid !== 'number' || typeof parsed.sessionId !== 'string') {
      return undefined;
    }
    return { pid: parsed.pid, sessionId: parsed.sessionId, cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined };
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Session ids with a running Claude Code process, from the CLI's own live-session registry — the
 * same source the official extension merges into its panel list. A registry file whose pid is
 * gone (a crashed process never removed it) is ignored rather than trusted.
 */
export async function liveSessionIds(
  sessionsDir: string = path.join(claudeHome(), 'sessions'),
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<Set<string>> {
  const live = new Set<string>();
  let names: string[];
  try {
    names = await fsp.readdir(sessionsDir);
  } catch {
    return live;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const entry = parseLiveSessionEntry(await fsp.readFile(path.join(sessionsDir, name), 'utf8'));
          if (entry && alive(entry.pid)) {
            live.add(entry.sessionId);
          }
        } catch {
          // unreadable registry file — not evidence of a live session
        }
      }),
  );
  return live;
}
