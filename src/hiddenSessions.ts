import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The official extension's own "delete" (`settings.hideSession()`) doesn't touch the transcript
// at all — it just appends the sessionId to `hiddenSessionIds` in VS Code's shared global-state
// key-value store (confirmed: `Anthropic.claude-code` key in `state.vscdb`'s `ItemTable`, alongside
// every other extension's global state — this is a shared, documented-shape VS Code file, not a
// private per-extension sandbox). Reading it lets us stop showing (and stop letting the user click
// into) sessions they already considered "deleted" via the official UI — a likely major cause of
// "opens an empty chat" reports, since most sessions on a well-used machine end up hidden this way.
//
// Read-only, `sqlite3 -readonly`, and fails silently to an empty set on any error (missing binary,
// missing file, different VS Code variant/OS layout, schema change) — this is a pure enhancement,
// never a hard dependency.
function stateDbPath(): string | undefined {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  return undefined;
}

export async function readHiddenSessionIds(): Promise<Set<string>> {
  const dbPath = stateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return new Set();
  }

  try {
    const { stdout } = await execFileAsync('sqlite3', [
      '-readonly',
      dbPath,
      "SELECT value FROM ItemTable WHERE key='Anthropic.claude-code';",
    ]);
    const raw = stdout.trim();
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as { hiddenSessionIds?: unknown };
    if (!Array.isArray(parsed.hiddenSessionIds)) {
      return new Set();
    }
    return new Set(parsed.hiddenSessionIds.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}
