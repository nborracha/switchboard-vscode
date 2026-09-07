import * as vscode from 'vscode';
import * as path from 'node:path';
import { ParsedSession, ResolvedScope, ScopedSession, listSessionsForScopes, projectsDir } from './sessionStore';
import { MetadataStore, SessionMetadata, workspaceIdentity } from './metadataStore';
import { readHiddenSessionIds } from './hiddenSessions';
import { tagColor } from './tagColor';
import { computeWorkingTransitions } from './workingState';
import { listRunningBackgroundAgents } from './backgroundAgents';

const REFRESH_DEBOUNCE_MS = 300;

// A session is treated as "working" while its last REAL turn (session.lastActivity — the same
// user/assistant-only signal sessionStore already computes to keep the displayed "time ago" from
// resetting on a mere open) happened within this window. Deliberately NOT based on raw file-write
// recency: merely opening a session causes Claude Code to append a housekeeping line with no real
// turn, which would otherwise show a chat as "working" (and then "ready for review" once it goes
// quiet) purely from having been opened.
//
// 60s, not 10s: a single tool call can legitimately block the CLI process for well over 10
// seconds with *zero* transcript writes in the meantime (confirmed by tracing a real transcript —
// a 93.9s gap between two consecutive real turns had no lines of any kind appended in between,
// not even housekeeping ones), so there is no file-based signal available during that window at
// all. A short threshold misreads a routine slow tool call as "finished" and flags it "ready for
// review" while the agent is still working. Real gaps seen during genuinely active work (13.5s,
// 15.8s, 19.3s, 30.3s) are common; 60s comfortably covers those. It does not eliminate the false
// positive for a rarer, longer-running tool call (multi-minute builds/tests/deploys) — no
// purely file-based heuristic can, since the CLI writes nothing to disk while blocked — but it
// removes the vast majority of routine cases. Raising this further trades fewer false positives
// for a slower "ready for review" signal on chats that are genuinely done.
const WORKING_IDLE_MS = 60_000;
// How often the working/needs-review state is re-evaluated. Deliberately much slower than a react-
// on-every-append debounce: a session that's continuously active re-triggers this check every tick
// but produces no visible change (still "working"), so no refresh is pushed — the list only
// actually redraws when a session's state truly transitions (starts, or finishes, working).
const TICK_INTERVAL_MS = 2_000;
// Scopes (workspace folders, their git worktrees, and each one's Claude Code project folder) are
// re-discovered on refresh, so a worktree added or a project folder created after activation shows
// up without a reload. Discovery runs a `git worktree list` per folder, so an un-forced refresh
// re-discovers at most this often; the watchers on the projects dir and on `.git/worktrees`, the
// workspace-folder change event and the explicit Refresh command force it.
const SCOPE_REDISCOVER_MIN_MS = 30_000;

/** Re-runs scope discovery + project-folder resolution — the same procedure activation runs. */
export type ScopeResolver = () => Promise<ResolvedScope[]>;

/** One line per scope, for the activation log and the "scopes changed" log. */
export function describeScopes(scopes: readonly ResolvedScope[]): string {
  return scopes.map((s) => `${s.label} -> ${s.projectFolder ?? '(none)'}`).join('; ');
}

/** Plain data holder — kept TreeItem-free since the list now renders as a webview, not a TreeView. */
export class SessionItem {
  constructor(
    public readonly session: ParsedSession,
    public readonly repoRoot: string,
    public readonly repoLabel: string,
    public readonly pinned: boolean,
    public readonly archived: boolean,
    public readonly hidden: boolean,
    public readonly tags: string[],
    public readonly backgroundAgentId?: string,
  ) {}
}

export type SectionKind = 'pinned' | 'chats' | 'archived' | 'hidden';

interface ClientTag {
  name: string;
  background: string;
  foreground: string;
}

interface ClientSession {
  sessionId: string;
  title: string;
  repoLabel: string;
  foreignScope: boolean;
  firstPrompt?: string;
  gitBranch?: string;
  lastActivity: number;
  pinned: boolean;
  archived: boolean;
  hidden: boolean;
  tags: ClientTag[];
  working: boolean;
  needsReview: boolean;
  backgroundAgentId?: string;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export class SessionListProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRediscover = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  // The current scope set, replaced wholesale by rediscoverScopes(). The stores and watchers below
  // only ever grow, so a scope that briefly disappears (a worktree being re-created) keeps both.
  private scopes: ResolvedScope[];
  private lastScopeDiscovery = 0;
  private rediscovering: Promise<void> | undefined;
  private readonly watchedRoots = new Set<string>();
  private readonly watchedFolders = new Set<string>();

  // One MetadataStore per scope, keyed by that scope's own root — keeps pins/tags/archive
  // scoped exactly like before (one file per repo, same hashing scheme), so a workspace that was
  // already using Switchboard with a single scope reads and writes the exact same metadata.json
  // it always did. No migration needed for the common single-repo case.
  private readonly metadataStores = new Map<string, MetadataStore>();

  // sessionIds considered "working" as of the last tick — compared against the live check each
  // tick to detect start/stop transitions without needing to refresh on every unchanged tick.
  private readonly workingAsOfLastTick = new Set<string>();
  // sessionIds that just finished a working burst and haven't been opened since — cleared by
  // markReviewed(). Transient/in-memory only: resets on reload, which is fine for a "you have
  // something new to look at" notification.
  private readonly needsReviewIds = new Set<string>();

  private readonly onDidRequestActionEmitter = new vscode.EventEmitter<{ action: string; sessionId: string }>();
  readonly onDidRequestAction = this.onDidRequestActionEmitter.event;

  constructor(
    initialScopes: ResolvedScope[],
    private readonly resolveScopes: ScopeResolver,
    private readonly log: (line: string) => void = (): void => undefined,
  ) {
    this.scopes = initialScopes;
    this.lastScopeDiscovery = Date.now();
    this.attachScopes(initialScopes);

    // A new project folder appearing means a chat was just started in a scope that had none — the
    // one case the per-folder watchers cannot see, because the folder they would watch did not
    // exist yet.
    this.watch(projectsDir(), '*', true);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh(true)));
  }

  /** Store, watchers and the tick for every scope not seen before; a no-op for known ones. */
  private attachScopes(scopes: ResolvedScope[]): void {
    for (const scope of scopes) {
      if (!this.metadataStores.has(scope.root)) {
        this.metadataStores.set(scope.root, new MetadataStore(workspaceIdentity(scope.root)));
      }
      if (!this.watchedRoots.has(scope.root)) {
        this.watchedRoots.add(scope.root);
        // `git worktree add/remove/prune` all show up here. A worktree's own `.git` is a file, so
        // this never fires for worktree roots themselves — harmless.
        this.watch(path.join(scope.root, '.git', 'worktrees'), '*', true);
      }
      if (scope.projectFolder && !this.watchedFolders.has(scope.projectFolder)) {
        this.watchedFolders.add(scope.projectFolder);
        // Only structural changes (a session appearing/disappearing) refresh immediately. A plain
        // append is picked up by the periodic tick instead (via listSessions' own parsed
        // lastActivity, not raw file-write recency — see WORKING_IDLE_MS above) rather than
        // reacting directly, which is what used to make the list reorder/redraw on every single
        // append from every concurrently-running agent.
        this.watch(scope.projectFolder, '*.jsonl', false);
      }
    }
    if (!this.tickTimer && scopes.some((scope) => scope.projectFolder)) {
      this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    }
  }

  private watch(base: string, glob: string, rediscover: boolean): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
    watcher.onDidCreate(() => this.scheduleRefresh(rediscover));
    watcher.onDidDelete(() => this.scheduleRefresh(rediscover));
    this.disposables.push(watcher);
  }

  /** The current scope set — for logging and diagnostics. */
  getScopes(): readonly ResolvedScope[] {
    return this.scopes;
  }

  private async rediscoverScopes(): Promise<void> {
    if (this.rediscovering) {
      return this.rediscovering;
    }
    this.rediscovering = (async () => {
      this.lastScopeDiscovery = Date.now();
      try {
        const next = await this.resolveScopes();
        const before = describeScopes(this.scopes);
        this.scopes = next;
        this.attachScopes(next);
        const after = describeScopes(next);
        if (before !== after) {
          this.log(`Scopes changed: ${after}`);
        }
      } catch (err) {
        this.log(`Scope re-discovery failed, keeping the current scopes: ${String(err)}`);
      } finally {
        this.rediscovering = undefined;
      }
    })();
    return this.rediscovering;
  }

  /** Resolves the metadata store owning a given session item — for pin/archive/tag/delete commands. */
  metadataStoreForItem(item: SessionItem): MetadataStore {
    const store = this.metadataStores.get(item.repoRoot);
    if (!store) {
      throw new Error(`Switchboard: no metadata store resolved for repo root ${item.repoRoot}`);
    }
    return store;
  }

  private async mergedMetadata(): Promise<Record<string, SessionMetadata>> {
    const all = await Promise.all([...this.metadataStores.values()].map((store) => store.getAll()));
    return Object.assign({}, ...all);
  }

  /** Merged metadata across every scope — for the full-text content search. */
  async getMergedMetadata(): Promise<Record<string, SessionMetadata>> {
    return this.mergedMetadata();
  }

  /** All distinct tags in use across every scope, sorted — lets tag reuse work across repos too. */
  async getAllTagsMerged(): Promise<string[]> {
    const all = await Promise.all([...this.metadataStores.values()].map((store) => store.getAllTags()));
    return [...new Set(all.flat())].sort((a, b) => a.localeCompare(b));
  }

  /** Every real session across every scope (hidden ones included) — for the full-text content search. */
  async getAllScopedSessions(): Promise<ScopedSession[]> {
    return listSessionsForScopes(this.scopes);
  }

  // Active chats append to their transcript many times per turn; without debouncing, each
  // append would trigger an immediate full refresh, causing visible stutter during normal use.
  private scheduleRefresh(rediscover = false): void {
    this.pendingRediscover = this.pendingRediscover || rediscover;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const rediscoverNow = this.pendingRediscover;
      this.pendingRediscover = false;
      void this.refresh({ rediscover: rediscoverNow });
    }, REFRESH_DEBOUNCE_MS);
  }

  // Only pushes a refresh when a session's working state actually flips — a continuously-active
  // session re-confirms "still working" every tick without ever causing a redraw, and a session
  // that goes quiet triggers exactly one refresh at the moment it's flagged for review.
  private async tick(): Promise<void> {
    if (!this.scopes.some((scope) => scope.projectFolder)) {
      return;
    }

    // Cheap unless a file's mtime actually changed since the last parse (listSessions caches by
    // mtime), so running this every tick doesn't reintroduce the cost Round 6 was avoiding.
    const sessions = await listSessionsForScopes(this.scopes);
    const lastActivityBySessionId = new Map(sessions.map((s) => [s.sessionId, s.lastActivity]));

    const { nowWorking, justFinished, changed } = computeWorkingTransitions(
      lastActivityBySessionId,
      this.workingAsOfLastTick,
      Date.now(),
      WORKING_IDLE_MS,
    );

    this.workingAsOfLastTick.clear();
    for (const sessionId of nowWorking) {
      this.workingAsOfLastTick.add(sessionId);
    }
    for (const sessionId of justFinished) {
      this.needsReviewIds.add(sessionId);
    }

    if (changed) {
      this.refresh();
    }
  }

  /** Clears the "needs review" flag — call when the user actually opens the session. */
  markReviewed(sessionId: string): void {
    this.needsReviewIds.delete(sessionId);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderShell(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: { type?: string; action?: string; sessionId?: string }) => {
      if (message?.type === 'ready') {
        this.refresh();
        return;
      }
      if (message?.type === 'action' && typeof message.action === 'string' && typeof message.sessionId === 'string') {
        this.onDidRequestActionEmitter.fire({ action: message.action, sessionId: message.sessionId });
      }
    });
  }

  /**
   * Re-reads everything and re-renders. Scopes are re-discovered too when asked (`rediscover`) or
   * when the last discovery is older than SCOPE_REDISCOVER_MIN_MS — so a worktree or a project
   * folder that appeared after activation is picked up without a reload.
   */
  async refresh(options: { rediscover?: boolean } = {}): Promise<void> {
    if (options.rediscover || Date.now() - this.lastScopeDiscovery > SCOPE_REDISCOVER_MIN_MS) {
      await this.rediscoverScopes();
    }
    const data = await this.buildData();
    this.view?.webview.postMessage({ type: 'render', ...data });
  }

  /** Reveals the view (switching Activity Bar tabs if needed) and focuses its inline filter box. */
  async focusSearch(): Promise<void> {
    await vscode.commands.executeCommand('switchboardSessions.focus');
    this.view?.webview.postMessage({ type: 'focusSearch' });
  }

  /**
   * True when this item's session lives in a different scope than the primary one — typically a
   * session Claude Code (CLI >= 2.1.198) relocated into one of the repo's git worktrees when the
   * agent entered it. Such a chat cannot be opened by the official panel in this window (verified on
   * extension 2.1.263: its session list is built with `includeWorktrees: false`, so it declines the
   * session and shows a blank chat), which is why the open path routes it to the chooser in
   * `switchboard.openForeignSession` instead of `switchboard.openSession`.
   */
  isForeignScope(item: SessionItem): boolean {
    return this.scopes.length > 0 && item.repoRoot !== this.scopes[0].root;
  }

  /** The primary (first) scope — this window's own workspace folder and its Claude Code project folder. */
  primaryScope(): ResolvedScope | undefined {
    return this.scopes[0];
  }

  private async buildAllItems(): Promise<Record<SectionKind, SessionItem[]>> {
    const buckets: Record<SectionKind, SessionItem[]> = { pinned: [], chats: [], archived: [], hidden: [] };
    if (!this.scopes.some((scope) => scope.projectFolder)) {
      return buckets;
    }

    const [sessions, metadata, hiddenIds, backgroundAgents] = await Promise.all([
      listSessionsForScopes(this.scopes),
      this.mergedMetadata(),
      readHiddenSessionIds(),
      listRunningBackgroundAgents(this.scopes.map((scope) => scope.root)),
    ]);

    for (const session of sessions) {
      const meta = metadata[session.sessionId] ?? {};
      const pinned = !!meta.pinned;
      const archived = !!meta.archived;
      const hidden = hiddenIds.has(session.sessionId);
      const backgroundAgentId = backgroundAgents.get(session.sessionId)?.id;
      const item = new SessionItem(session, session.repoRoot, session.repoLabel, pinned, archived, hidden, meta.tags ?? [], backgroundAgentId);

      // Priority: pinned (an explicit action in this tool) beats everything else; then the
      // official extension's own hidden state; then our own archive; otherwise the main list.
      if (pinned) {
        buckets.pinned.push(item);
      } else if (hidden) {
        buckets.hidden.push(item);
      } else if (archived) {
        buckets.archived.push(item);
      } else {
        buckets.chats.push(item);
      }
    }

    return buckets;
  }

  async resolveItem(sessionId: string): Promise<SessionItem | undefined> {
    const buckets = await this.buildAllItems();
    for (const items of Object.values(buckets)) {
      const found = items.find((item) => item.session.sessionId === sessionId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private toClientSession(item: SessionItem, allTagsSorted: string[]): ClientSession {
    const working = Date.now() - item.session.lastActivity < WORKING_IDLE_MS;
    return {
      sessionId: item.session.sessionId,
      title: item.session.title,
      repoLabel: item.repoLabel,
      foreignScope: this.isForeignScope(item),
      firstPrompt: item.session.firstPrompt,
      gitBranch: item.session.gitBranch,
      lastActivity: item.session.lastActivity,
      pinned: item.pinned,
      archived: item.archived,
      hidden: item.hidden,
      tags: item.tags.map((name) => ({ name, ...tagColor(name, allTagsSorted) })),
      working,
      // A working agent is never "ready for review" — mask a stale flag (set by an earlier tick,
      // before the agent picked up new work again) rather than showing both at once. This is the
      // single point both the tick's cached view and this render's live recheck of lastActivity
      // funnel through, so the invariant holds regardless of tick timing.
      needsReview: !working && this.needsReviewIds.has(item.session.sessionId),
      backgroundAgentId: item.backgroundAgentId,
    };
  }

  private async buildData(): Promise<{ sections: Record<SectionKind, ClientSession[]>; resolved: boolean }> {
    const [buckets, allTagsSorted] = await Promise.all([this.buildAllItems(), this.getAllTagsMerged()]);
    const sections = {
      pinned: buckets.pinned.map((i) => this.toClientSession(i, allTagsSorted)),
      chats: buckets.chats.map((i) => this.toClientSession(i, allTagsSorted)),
      archived: buckets.archived.map((i) => this.toClientSession(i, allTagsSorted)),
      hidden: buckets.hidden.map((i) => this.toClientSession(i, allTagsSorted)),
    };
    return { sections, resolved: this.scopes.some((scope) => scope.projectFolder) };
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .empty { padding: 12px; opacity: 0.7; }
  .search-box { padding: 6px 8px; position: sticky; top: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); z-index: 1; }
  .search-input { width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit; }
  .search-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .section-header { display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; user-select: none; font-weight: 600; opacity: 0.85; }
  .section-header:hover { background: var(--vscode-list-hoverBackground); }
  .section-header .chevron { flex: 0 0 auto; width: 1em; display: inline-block; transition: transform 0.1s; }
  .section-header.collapsed .chevron { transform: rotate(-90deg); }
  .section-body.collapsed { display: none; }
  .row { display: flex; align-items: center; gap: 4px; padding: 3px 8px 3px 20px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row-icon { flex: 0 0 auto; opacity: 0.75; display: flex; position: relative; }
  .row-icon .review-dot, .row-icon .working-dot { position: absolute; top: -2px; right: -3px; width: 6px; height: 6px; border-radius: 50%; }
  .row-icon .review-dot { background: var(--vscode-notificationsWarningIcon-foreground, #cca700); }
  .row-icon .working-dot { background: var(--vscode-charts-blue, #3794ff); animation: ccm-pulse 1.2s ease-in-out infinite; }
  @keyframes ccm-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
  .row-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-title.needs-review { font-weight: 700; }
  .row-tags { flex: 0 0 auto; display: flex; gap: 4px; margin-left: 6px; }
  .chip { flex: 0 0 auto; padding: 1px 7px; border-radius: 9px; font-size: 0.82em; white-space: nowrap; line-height: 1.5; }
  .row-repo { flex: 0 1 auto; min-width: 0; max-width: 30%; overflow: hidden; text-overflow: ellipsis; opacity: 0.55; font-size: 0.82em; margin-left: 6px; white-space: nowrap; }
  .row-time { flex: 0 0 auto; opacity: 0.6; font-size: 0.85em; margin-left: 6px; white-space: nowrap; }
  .row-actions { flex: 0 0 auto; display: none; gap: 2px; margin-left: 4px; }
  .row:hover .row-actions, .row:focus-within .row-actions { display: flex; }
  .icon-btn { flex: 0 0 auto; background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.75; cursor: pointer; padding: 2px 4px; border-radius: 3px; display: flex; align-items: center; }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .icon-btn.active { opacity: 1; color: var(--vscode-terminal-ansiYellow, #e2c08d); }
  svg { width: 14px; height: 14px; fill: currentColor; }
</style>
</head>
<body>
<div class="search-box"><input id="search-input" class="search-input" type="search" placeholder="Filter chats by title, prompt, or tag..." /></div>
<div id="root"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const state = vscode.getState() || { collapsed: {} };
  let lastMessage = null;

  const ICONS = {
    pin: '<svg viewBox="0 0 16 16"><path d="M9.5 1a.5.5 0 0 1 .5.5V3l2.5 2.5.7-.7a.5.5 0 0 1 .7.7l-1 1a.5.5 0 0 1-.35.15H11l-2 2v3.35a.5.5 0 0 1-.85.36L6 10.21 3.35 12.85a.5.5 0 0 1-.7-.7L5.29 9.5l-2.15-2.15A.5.5 0 0 1 3.5 6.5h3.35l2-2V3.35a.5.5 0 0 1 .15-.35l1-1A.5.5 0 0 1 9.5 1z"/></svg>',
    archive: '<svg viewBox="0 0 16 16"><path d="M1.5 3h13a.5.5 0 0 1 .5.5V5H1V3.5a.5.5 0 0 1 .5-.5zM1 6h14v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5V6zm5 2.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H6z"/></svg>',
    unarchive: '<svg viewBox="0 0 16 16"><path d="M1.5 3h13a.5.5 0 0 1 .5.5V5H1V3.5a.5.5 0 0 1 .5-.5zM1 6h14v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5V6zm7 1.5-2.5 2.5H7v2h2v-2h1.5L8 7.5z"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></svg>',
    edit: '<svg viewBox="0 0 16 16"><path d="M11 2l3 3-8 8-4 1 1-4 8-8z"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6.4L3 15.2V12H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>',
    background: '<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="9" rx="1"/><rect x="4" y="13" width="8" height="1.5" rx="0.5"/></svg>',
  };

  const SECTION_LABELS = { pinned: 'Pinned', chats: 'Chats', archived: 'Archived', hidden: 'Hidden by Claude Code' };
  const SECTION_ORDER = ['pinned', 'chats', 'archived', 'hidden'];

  function timeAgo(ms) {
    const diffMinutes = Math.floor((Date.now() - ms) / 60000);
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return diffMinutes + 'm ago';
    const hours = Math.floor(diffMinutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function sessionMatchesQuery(session, query) {
    if (session.title.toLowerCase().includes(query)) return true;
    if (session.firstPrompt && session.firstPrompt.toLowerCase().includes(query)) return true;
    if (session.repoLabel && session.repoLabel.toLowerCase().includes(query)) return true;
    return session.tags.some((tag) => tag.name.toLowerCase().includes(query));
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function iconButton(name, svg, title, active) {
    const btn = el('button', 'icon-btn' + (active ? ' active' : ''));
    btn.title = title;
    btn.innerHTML = svg;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'action', action: name, sessionId: btn.dataset.sessionId });
    });
    return btn;
  }

  function renderRow(session, showRepo) {
    const row = el('div', 'row');
    row.tabIndex = 0;

    const icon = el('span', 'row-icon');
    icon.innerHTML = session.backgroundAgentId
      ? ICONS.background
      : session.pinned
        ? ICONS.pin
        : session.archived
          ? ICONS.archive
          : ICONS.chat;
    if (session.backgroundAgentId) icon.title = 'Running as a background agent';
    // Same corner badge slot for both — working and needsReview are mutually exclusive (a
    // working agent is never "ready for review"), so there's never a clash to resolve.
    if (session.working) {
      const dot = el('span', 'working-dot');
      dot.title = 'Working…';
      icon.appendChild(dot);
    } else if (session.needsReview) {
      const dot = el('span', 'review-dot');
      dot.title = 'Ready for review';
      icon.appendChild(dot);
    }
    row.appendChild(icon);

    const title = el('span', 'row-title' + (session.needsReview ? ' needs-review' : ''), session.title);
    title.title = session.firstPrompt || session.title;
    row.appendChild(title);

    const tags = el('span', 'row-tags');
    for (const tag of session.tags) {
      const chip = el('span', 'chip', tag.name);
      chip.style.background = tag.background;
      chip.style.color = tag.foreground;
      tags.appendChild(chip);
    }
    row.appendChild(tags);

    if (showRepo && session.repoLabel) {
      const repoBadge = el('span', 'row-repo', session.repoLabel);
      repoBadge.title = session.foreignScope
        ? 'Lives in ' + session.repoLabel + '. The Claude Code panel in this window cannot open it from there; clicking offers to move it here, open a window at that folder, or resume it in a terminal.'
        : session.repoLabel;
      row.appendChild(repoBadge);
    }

    row.appendChild(el('span', 'row-time', timeAgo(session.lastActivity)));

    const actions = el('span', 'row-actions');
    const pinBtn = iconButton(session.pinned ? 'unpin' : 'pin', ICONS.pin, session.pinned ? 'Unpin' : 'Pin', session.pinned);
    pinBtn.dataset.sessionId = session.sessionId;
    const archiveBtn = iconButton(
      session.archived ? 'unarchive' : 'archive',
      session.archived ? ICONS.unarchive : ICONS.archive,
      session.archived ? 'Unarchive' : 'Archive',
      session.archived,
    );
    archiveBtn.dataset.sessionId = session.sessionId;
    const editBtn = iconButton('rename', ICONS.edit, 'Rename');
    editBtn.dataset.sessionId = session.sessionId;
    const moreBtn = iconButton('more', ICONS.more, 'More actions');
    moreBtn.dataset.sessionId = session.sessionId;
    actions.appendChild(pinBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(editBtn);
    actions.appendChild(moreBtn);
    row.appendChild(actions);

    row.addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'open', sessionId: session.sessionId }));
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') vscode.postMessage({ type: 'action', action: 'open', sessionId: session.sessionId });
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'action', action: 'more', sessionId: session.sessionId });
    });

    return row;
  }

  function renderSection(kind, sessions, forceExpanded, showRepo) {
    const wrapper = el('div');
    const collapsed = forceExpanded ? false : !!state.collapsed[kind];

    const header = el('div', 'section-header' + (collapsed ? ' collapsed' : ''));
    header.appendChild(el('span', 'chevron', '▾'));
    header.appendChild(el('span', '', SECTION_LABELS[kind] + ' (' + sessions.length + ')'));

    const body = el('div', 'section-body' + (collapsed ? ' collapsed' : ''));
    for (const session of sessions) {
      body.appendChild(renderRow(session, showRepo));
    }

    header.addEventListener('click', () => {
      const nowCollapsed = !body.classList.contains('collapsed');
      body.classList.toggle('collapsed', nowCollapsed);
      header.classList.toggle('collapsed', nowCollapsed);
      state.collapsed[kind] = nowCollapsed;
      vscode.setState(state);
    });

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
  }

  const searchInput = document.getElementById('search-input');

  function currentQuery() {
    return (searchInput.value || '').trim().toLowerCase();
  }

  function renderFromLastMessage() {
    if (!lastMessage) return;
    root.innerHTML = '';
    if (!lastMessage.resolved) {
      root.appendChild(el('div', 'empty', 'Could not resolve a Claude Code chat history folder for this workspace.'));
      return;
    }

    const allRepoLabels = new Set();
    for (const kind of SECTION_ORDER) {
      for (const s of lastMessage.sections[kind]) {
        if (s.repoLabel) allRepoLabels.add(s.repoLabel);
      }
    }
    const showRepo = allRepoLabels.size > 1;

    const query = currentQuery();
    let total = 0;
    let matched = 0;
    for (const kind of SECTION_ORDER) {
      const sessions = lastMessage.sections[kind];
      total += sessions.length;
      const filtered = query ? sessions.filter((s) => sessionMatchesQuery(s, query)) : sessions;
      matched += filtered.length;
      if (query && filtered.length === 0) continue;
      root.appendChild(renderSection(kind, filtered, !!query, showRepo));
    }
    if (total === 0) {
      root.appendChild(el('div', 'empty', 'No Claude Code chats found for this workspace yet.'));
    } else if (query && matched === 0) {
      root.appendChild(el('div', 'empty', 'No chats match "' + searchInput.value.trim() + '".'));
    }
  }

  searchInput.addEventListener('input', renderFromLastMessage);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'focusSearch') {
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (message.type !== 'render') return;
    lastMessage = message;
    renderFromLastMessage();
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}
