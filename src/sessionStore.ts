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
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/** `~/.claude/file-history/<sessionId>/` — confirmed session-keyed sidecar data; callers deleting a session must clean this up too. */
export function fileHistoryDir(sessionId: string): string {
  return path.join(claudeHome(), 'file-history', sessionId);
}

// Reverse-engineered from real folders on disk: every `/`, `\\`, AND `.` in the cwd becomes `-`
// (confirmed against a real git worktree path — its `.worktrees` segment produces a literal
// double-dash `--worktrees-` in the folder name, from the path separator and the leading dot each
// contributing their own dash). Previously this only replaced path separators, which happened to
// still work for every workspace root tried so far only because none of them contained a dot.
function naiveEncode(cwd: string): string {
  return cwd.replace(/[/\\.]/g, '-');
}

/**
 * The folder Claude Code itself would create for `root` (its deterministic encoding, see
 * `naiveEncode`) — for writing into a scope that has no project folder yet, e.g. moving a chat into
 * a workspace no chat was ever started in. `resolveProjectFolder` is for reading: it prefers a
 * folder that already exists, whatever its name.
 */
export function defaultProjectFolder(root: string): string {
  return path.join(projectsDir(), naiveEncode(root));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
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
 * Resolves the `~/.claude/projects/<...>` folder for a workspace root.
 *
 * Tries Claude Code's own deterministic path-encoding first (see `naiveEncode`) — this is the
 * ONLY reliable strategy for a workspace root an agent `cd`ed into mid-session (e.g. a git
 * worktree): the file Claude Code stores for that session keeps its ORIGINAL cwd in its content
 * for however many lines came before the `cd`, so content-sniffing for a matching `cwd` field can
 * never find a match for the worktree's own root, only for whichever root the file started under.
 *
 * Falls back to sniffing every candidate folder's session files for a matching `cwd` field only
 * when the encoded name doesn't exist — e.g. an older folder created before this encoding was
 * confirmed, or one some other Claude Code version named differently. If more than one folder's
 * sessions carry a matching `cwd` (e.g. a reused scratch path used by two unrelated project
 * instances over time), the folder with the most recently modified session wins rather than
 * whichever `readdir` happens to return first.
 */
export async function resolveProjectFolder(workspaceRoot: string): Promise<string | undefined> {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  const encoded = path.join(dir, naiveEncode(workspaceRoot));
  if (fs.existsSync(encoded)) {
    return encoded;
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

  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => b.mostRecentMtime - a.mostRecentMtime);
  return matches[0].folder;
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

/**
 * The two records Claude Code itself appends when a session leaves a worktree (verified against the
 * CLI's `relocateSessionTranscript` and `saveWorktreeState(undefined)`): a `relocated` stamp naming
 * the new cwd, and a `worktree-state` with a null session. Both record types are "last wins" for
 * every reader — the CLI's resume, the official panel's session list, and our own parser — so
 * appending them re-homes the session for all of them at once.
 */
export function relocatedRecord(sessionId: string, relocatedCwd: string): string {
  return JSON.stringify({ type: 'relocated', sessionId, relocatedCwd });
}

export function worktreeExitRecord(sessionId: string): string {
  return JSON.stringify({ type: 'worktree-state', worktreeSession: null, sessionId });
}

/** The CLI's own naming when a relocation finds a file already at the destination. */
export function supersededPath(destination: string, now: number): string {
  return `${destination}.superseded-${now}`;
}

export interface RelocationResult {
  newFilePath: string;
  /** Where a pre-existing destination transcript was set aside, if there was one. */
  setAside?: string;
  sidecarMoved: boolean;
  /** Where a pre-existing destination `<sessionId>/` sidecar dir was set aside, if there was one. */
  sidecarSetAside?: string;
}

/**
 * Sets aside whatever is at `destination` (file or dir) under the CLI's own `.superseded-<ts>`
 * naming, so a move never overwrites — returns the new path, or undefined when nothing was there.
 */
async function setAsideExisting(destination: string, now: number): Promise<string | undefined> {
  if (!(await exists(destination))) {
    return undefined;
  }
  const aside = supersededPath(destination, now);
  await fsp.rename(destination, aside);
  return aside;
}

/**
 * Moves a session's transcript (and its `<sessionId>/` sidecar folder: subagents, custom-title.json)
 * into another project folder and stamps it the way Claude Code's own ExitWorktree does, so the
 * session becomes a plain session of `targetRoot` everywhere. Mirrors the CLI step for step:
 * ensure the destination folder, set aside an existing destination as `.superseded-<ts>` rather
 * than overwrite it, `rename` (same filesystem — both live under the projects dir), then append the
 * stamps. Callers must make sure no Claude Code process is still writing the file (see
 * liveSessions.ts) — the CLI only ever does this from inside the owning process.
 */
export async function relocateSession(
  filePath: string,
  sessionId: string,
  targetProjectFolder: string,
  targetRoot: string,
  now: number = Date.now(),
): Promise<RelocationResult> {
  await fsp.mkdir(targetProjectFolder, { recursive: true, mode: 0o700 });
  const newFilePath = path.join(targetProjectFolder, `${sessionId}.jsonl`);
  const moving = newFilePath !== filePath;
  let setAside: string | undefined;
  let sidecarMoved = false;
  let sidecarSetAside: string | undefined;

  if (moving) {
    setAside = await setAsideExisting(newFilePath, now);
    await fsp.rename(filePath, newFilePath);
  }

  // Stamped right after the transcript itself has moved: whatever happens to the sidecar below,
  // the transcript is never left at its new home without the records that re-home it.
  await fsp.appendFile(newFilePath, `\n${relocatedRecord(sessionId, targetRoot)}\n${worktreeExitRecord(sessionId)}\n`, 'utf8');
  invalidateSession(filePath);
  invalidateSession(newFilePath);

  if (moving) {
    const oldSidecar = path.join(path.dirname(filePath), sessionId);
    const newSidecar = path.join(targetProjectFolder, sessionId);
    if (await exists(oldSidecar)) {
      // A leftover sidecar at the destination (from an earlier stay of this session there) would
      // make `rename` fail with ENOTEMPTY — set it aside the same way the CLI sets aside a file.
      sidecarSetAside = await setAsideExisting(newSidecar, now);
      await fsp.rename(oldSidecar, newSidecar);
      sidecarMoved = true;
    }
  }

  return { newFilePath, setAside, sidecarMoved, sidecarSetAside };
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

export interface ResolvedScope {
  /** Absolute path this scope represents (a VS Code workspace folder, or one of its git worktrees). */
  root: string;
  /** Human label for the UI. */
  label: string;
  /** This scope's own Claude Code project folder, or undefined if none could be resolved. */
  projectFolder: string | undefined;
}

export type ScopedSession = ParsedSession & { repoRoot: string; repoLabel: string };

/**
 * Resolves each scope's own Claude Code project folder into its sessions, tags every session with
 * which repo it came from, and merges everything into one list — so a workspace with multiple
 * open repos (or a repo with git worktrees an agent `cd`ed into mid-session) shows every real
 * session instead of only whichever single folder a naive one-folder resolution happened to pick.
 */
export async function listSessionsForScopes(scopes: ResolvedScope[]): Promise<ScopedSession[]> {
  const perScope = await Promise.all(
    scopes.map(async (scope) => {
      if (!scope.projectFolder) {
        return [];
      }
      let sessions: ParsedSession[];
      try {
        sessions = await listSessions(scope.projectFolder);
      } catch (err) {
        // A folder resolved earlier can be gone by now (a removed worktree's history deleted by
        // hand) — that scope simply has no sessions; the other scopes must still render.
        if (!isEnoent(err)) {
          throw err;
        }
        return [];
      }
      return sessions.map((session) => ({ ...session, repoRoot: scope.root, repoLabel: scope.label }));
    }),
  );
  return perScope.flat().sort((a, b) => b.lastActivity - a.lastActivity);
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
