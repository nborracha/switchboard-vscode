import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// Derived from the full repo/worktree root path (not just its basename, which two unrelated repos
// can share) so pin/tag sidecar stores never collide across scopes. Moved here from extension.ts
// so SessionListProvider can build one MetadataStore per resolved scope on its own.
export function workspaceIdentity(workspaceRoot: string): string {
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 8);
  return `${path.basename(workspaceRoot)}-${hash}`;
}

export interface SessionMetadata {
  pinned?: boolean;
  archived?: boolean;
  tags?: string[];
}

type MetadataFile = Record<string, SessionMetadata>;

/**
 * The metadata for one session, out of every scope's store, keyed by scope root.
 *
 * The scope the session lives in NOW always wins. A session can change scope — Claude Code moves a
 * transcript into a worktree's project folder when the agent enters it, and Switchboard's own
 * "Move into this workspace" moves it back — and each scope keeps its own metadata.json. The entry
 * left behind in the previous scope is stale: it records what the chat was when it lived there. A
 * plain merge across stores let that stale entry win (later stores overwrote earlier ones), so a
 * pin or unarchive clicked after a move was written correctly and then immediately overridden on
 * the next render, which looked exactly like the click doing nothing.
 *
 * Another scope's entry is still used when the owning scope has none, so a pin made before a move
 * survives the move until the first write in the new scope replaces it.
 */
export function pickScopedMetadata(
  perScope: ReadonlyMap<string, MetadataFile>,
  sessionId: string,
  repoRoot: string,
): SessionMetadata {
  const own = perScope.get(repoRoot)?.[sessionId];
  if (own) {
    return own;
  }
  for (const [root, entries] of perScope) {
    const entry = root === repoRoot ? undefined : entries[sessionId];
    if (entry) {
      return entry;
    }
  }
  return {};
}

function storeRoot(): string {
  return process.env.CLAUDE_CHAT_MANAGER_HOME || path.join(os.homedir(), '.claude-chat-manager');
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Sidecar store for pin/tag metadata, entirely separate from Anthropic's own `~/.claude` files.
 * One JSON file per resolved workspace project folder, mirroring Claude's own per-workspace layout.
 */
export class MetadataStore {
  private readonly filePath: string;
  private cache: MetadataFile | undefined;

  constructor(workspaceFolderName: string) {
    this.filePath = path.join(storeRoot(), workspaceFolderName, 'metadata.json');
  }

  private async load(): Promise<MetadataFile> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as MetadataFile;
    } catch (err) {
      // A missing file just means no metadata yet — safe to start empty. Anything else (a
      // corrupted/partial write from a crash, a permissions error) must NOT be silently treated
      // as empty, or the next save would clobber every other session's real pins/tags.
      if (isEnoent(err)) {
        this.cache = {};
      } else {
        throw new Error(`Switchboard: could not read metadata at ${this.filePath}: ${String(err)}`);
      }
    }
    return this.cache;
  }

  private async save(data: MetadataFile): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a truncated metadata.json behind.
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmpPath, this.filePath);
    this.cache = data;
  }

  async getAll(): Promise<MetadataFile> {
    return this.load();
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const data = await this.load();
    data[sessionId] = { ...data[sessionId], pinned };
    await this.save(data);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const data = await this.load();
    data[sessionId] = { ...data[sessionId], archived };
    await this.save(data);
  }

  async setTags(sessionId: string, tags: string[]): Promise<void> {
    const data = await this.load();
    data[sessionId] = { ...data[sessionId], tags };
    await this.save(data);
  }

  /** Merges a whole entry in — used to carry a session's pins/tags/archive across a scope move. */
  async mergeEntry(sessionId: string, meta: SessionMetadata): Promise<void> {
    const data = await this.load();
    data[sessionId] = { ...data[sessionId], ...meta };
    await this.save(data);
  }

  async removeSession(sessionId: string): Promise<void> {
    const data = await this.load();
    delete data[sessionId];
    await this.save(data);
  }

  /** All distinct tags in use across every session in this workspace, sorted alphabetically. */
  async getAllTags(): Promise<string[]> {
    const data = await this.load();
    const tags = new Set<string>();
    for (const meta of Object.values(data)) {
      for (const tag of meta.tags ?? []) {
        tags.add(tag);
      }
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }
}
