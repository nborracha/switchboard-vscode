import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

export interface ParsedSession {
  sessionId: string;
  filePath: string;
  title: string;
  firstPrompt?: string;
  /** Raw file mtime — touched by Claude Code just from opening a session, not just real activity. Use `lastActivity` for anything user-facing. */
  lastModified: number;
  /** Timestamp of the most recent real `user`/`assistant` turn — what "last used" should mean. Falls back to `lastModified` if a session has no timestamped turns yet. */
  lastActivity: number;
  createdAt?: number;
  gitBranch?: string;
  hasSubagents: boolean;
}

// Claude Code itself honors CLAUDE_CONFIG_DIR (seen in the official extension's env handling) —
// respecting it here keeps us correct on such setups and lets tests point at a fixture dir
// instead of ever touching the developer's real history.
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/** `~/.claude/file-history/<sessionId>/` — confirmed session-keyed sidecar data; callers deleting a session must clean this up too. */
export function fileHistoryDir(sessionId: string): string {
  return path.join(claudeHome(), 'file-history', sessionId);
}

function naiveEncode(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

const NOISE_MARKERS = [
  '<command-name>',
  '<local-command-caveat>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  // The official VS Code extension auto-prepends the IDE's current state (open file, selection,
  // diagnostics) as its own text block ahead of whatever the user actually typed — most visibly
  // on the first turn of a session forked from the official UI, where it's the block, with no
  // real prompt following it yet.
  '<ide_opened_file>',
  '<ide_selection>',
  '<ide_diagnostics>',
];

function isNoiseText(text: string): boolean {
  return NOISE_MARKERS.some((marker) => text.includes(marker));
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // Prefer the first non-noise text block, not just the first text block — a real prompt
    // typed alongside IDE context lands as a *second* block, after the auto-injected one.
    const textBlocks = content.filter(
      (block): block is { type: string; text: string } =>
        !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    );
    const realBlock = textBlocks.find((block) => !isNoiseText(block.text));
    return (realBlock ?? textBlocks[0])?.text;
  }
  return undefined;
}

function safeJsonParse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Bounded so resolving many project folders on activation stays cheap — a session's cwd is
// reliably within the first line or two in every transcript we've inspected, so 16 KB comfortably
// covers real first lines while still bounding worst-case I/O per candidate file.
const CWD_HINT_READ_BYTES = 16384;

async function readCwdHint(jsonlPath: string): Promise<string | undefined> {
  const fh = await fsp.open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(CWD_HINT_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CWD_HINT_READ_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');

    for (const line of text.split('\n')) {
      if (line.trim()) {
        const obj = safeJsonParse(line);
        if (obj && typeof obj.cwd === 'string') {
          return obj.cwd;
        }
      }
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

/**
 * Resolves the `~/.claude/projects/<...>` folder for a workspace root without hand-rolling
 * Claude's path-encoding scheme: matches on the `cwd` field already present in each session's
 * transcript, falling back to the observed naive encoding only if no folder's sessions carry it.
 *
 * If more than one folder's sessions carry a matching `cwd` (e.g. a reused scratch path used by
 * two unrelated project instances over time), the folder with the most recently modified session
 * wins rather than whichever `readdir` happens to return first.
 */
export async function resolveProjectFolder(workspaceRoot: string): Promise<string | undefined> {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const candidateDirs = entries.filter((e) => e.isDirectory());

  const matches: { folder: string; mostRecentMtime: number }[] = [];

  await Promise.all(
    candidateDirs.map(async (candidate) => {
      const folder = path.join(dir, candidate.name);
      const files = (await fsp.readdir(folder)).filter((f) => f.endsWith('.jsonl')).slice(0, 3);
      if (files.length === 0) {
        return;
      }

      const cwds = await Promise.all(files.map((file) => readCwdHint(path.join(folder, file))));
      if (!cwds.some((cwd) => cwd === workspaceRoot)) {
        return;
      }

      const mtimes = await Promise.all(files.map(async (file) => (await fsp.stat(path.join(folder, file))).mtimeMs));
      matches.push({ folder, mostRecentMtime: Math.max(...mtimes) });
    }),
  );

  if (matches.length > 0) {
    matches.sort((a, b) => b.mostRecentMtime - a.mostRecentMtime);
    return matches[0].folder;
  }

  const naive = path.join(dir, naiveEncode(workspaceRoot));
  return fs.existsSync(naive) ? naive : undefined;
}

type ParsedFields = Omit<ParsedSession, 'lastModified' | 'hasSubagents'>;

const parseCache = new Map<string, { mtimeMs: number; parsed: ParsedFields }>();

/** Drops a cached parse — call after a session file is deleted so a stale entry can't leak forever. */
export function invalidateSession(filePath: string): void {
  parseCache.delete(filePath);
}

/**
 * Renames a session by appending a `custom-title` line — the exact event type the official
 * extension itself uses for renames (confirmed in real transcripts), so a rename made here is
 * also picked up if the session is later opened in the official panel. Append-only, matching how
 * every other write to these files already happens; `parseSession`'s title logic already treats
 * the last `custom-title` line as authoritative, so no parser changes are needed.
 */
export async function renameSession(filePath: string, sessionId: string, newTitle: string): Promise<void> {
  const line = JSON.stringify({ type: 'custom-title', customTitle: newTitle, sessionId });
  await fsp.appendFile(filePath, `\n${line}\n`, 'utf8');
}

/**
 * Duplicates a session's entire transcript as a new, independent session — a workaround for the
 * official UI only letting you fork from one of your OWN messages. Since every real turn (not
 * just user ones) is already persisted, copying the whole file and continuing from a fresh prompt
 * effectively forks from the assistant's last reply, without needing to write and wait on a filler
 * message first just to create a fork point.
 *
 * Every line stamps its own `sessionId` — a global string replace of the old UUID for a newly
 * generated one keeps the copy internally self-consistent (distinct from the original, not a
 * confusing duplicate claiming the same id) without needing to parse/rewrite the JSONL structure.
 * Does not copy the `<sessionId>/subagents/` subfolder or `~/.claude/file-history/<sessionId>/` —
 * those are historical artifacts of completed sub-work, not needed for the fork to continue
 * correctly from where the original left off.
 */
export async function forkSession(filePath: string, oldSessionId: string): Promise<{ newSessionId: string; newFilePath: string }> {
  const newSessionId = randomUUID();
  const original = await fsp.readFile(filePath, 'utf8');
  const forked = original.split(oldSessionId).join(newSessionId);
  const newFilePath = path.join(path.dirname(filePath), `${newSessionId}.jsonl`);
  await fsp.writeFile(newFilePath, forked, 'utf8');
  return { newSessionId, newFilePath };
}

interface ParseState {
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  createdAt?: number;
  lastActivity?: number;
}

// Real conversational turns only — opening a session (with zero user activity) still causes
// Claude Code to append housekeeping lines (e.g. `mode`, `system`), which would otherwise make
// "last used" reset to "just now" just from viewing a chat.
const ACTIVITY_TYPES = new Set(['user', 'assistant']);

function applyLine(obj: Record<string, unknown>, state: ParseState): void {
  if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
    state.customTitle = obj.customTitle; // a later rename should win, so keep scanning
    return;
  }
  if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
    state.aiTitle = obj.aiTitle;
    return;
  }
  if (obj.type === 'user' && !obj.isMeta && !state.firstPrompt) {
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === 'user') {
      const text = extractText(message.content);
      if (text && !isNoiseText(text)) {
        state.firstPrompt = text.slice(0, 200);
      }
    }
  }

  if (!state.gitBranch && typeof obj.gitBranch === 'string') {
    state.gitBranch = obj.gitBranch;
  }
  if (typeof obj.timestamp === 'string') {
    const t = Date.parse(obj.timestamp);
    if (!Number.isNaN(t)) {
      if (!state.createdAt) {
        state.createdAt = t;
      }
      if (typeof obj.type === 'string' && ACTIVITY_TYPES.has(obj.type) && !obj.isMeta) {
        if (!state.lastActivity || t > state.lastActivity) {
          state.lastActivity = t;
        }
      }
    }
  }
}

async function parseSession(filePath: string): Promise<ParsedFields> {
  const sessionId = path.basename(filePath, '.jsonl');
  const state: ParseState = {};

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.trim()) {
        const obj = safeJsonParse(line);
        if (obj) {
          applyLine(obj, state);
        }
      }
    }
  } catch {
    // transcript became unreadable mid-scan (deleted/rotated concurrently) — return partial results
  } finally {
    rl.close();
    stream.destroy();
  }

  const title = state.customTitle || state.aiTitle || state.firstPrompt || sessionId;
  return {
    sessionId,
    filePath,
    title,
    firstPrompt: state.firstPrompt,
    gitBranch: state.gitBranch,
    createdAt: state.createdAt,
    lastActivity: state.lastActivity ?? 0,
  };
}

async function parseSessionCached(filePath: string, mtimeMs: number): Promise<ParsedFields> {
  const cached = parseCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.parsed;
  }
  const parsed = await parseSession(filePath);
  parseCache.set(filePath, { mtimeMs, parsed });
  return parsed;
}

/** Lists top-level chat sessions in a project folder (subagent transcripts live in subfolders and are excluded). */
export async function listSessions(projectFolder: string): Promise<ParsedSession[]> {
  const entries = await fsp.readdir(projectFolder, { withFileTypes: true });
  const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  const dirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));

  const sessions = await Promise.all(
    jsonlFiles.map(async (entry) => {
      const filePath = path.join(projectFolder, entry.name);
      const stat = await fsp.stat(filePath);
      const parsed = await parseSessionCached(filePath, stat.mtimeMs);
      return {
        ...parsed,
        lastModified: stat.mtimeMs,
        // A brand-new session has no timestamped turns yet (or the earliest lines predate this
        // field) — file mtime is the only signal available until a real message lands.
        lastActivity: parsed.lastActivity || stat.mtimeMs,
        hasSubagents: dirNames.has(path.basename(entry.name, '.jsonl')),
      };
    }),
  );

  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}
