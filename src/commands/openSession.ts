import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import { callOfficialCommandOrFallback } from './officialCommandBridge';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { PENDING_OPEN_KEY, PendingOpen, isPendingOpen, matchesPendingOpen } from '../pendingOpen';
import { defaultProjectFolder, relocateSession } from '../sessionStore';
import { liveSessionIds } from '../liveSessions';

// A transcript written this recently may still have a process attached that the live registry
// hasn't caught up with (or that runs under another CLAUDE_CONFIG_DIR) — ask before moving it.
const RECENT_WRITE_MS = 60_000;

const OFFICIAL_OPEN_COMMAND = 'claude-vscode.editor.open';

// Give the official extension time to finish its own `onStartupFinished` activation in a freshly
// opened window before we hand it a session; the bridge's single 300ms retry alone is too tight
// for a cold window.
const PENDING_OPEN_ACTIVATION_DELAY_MS = 1500;

// Session ids come from file names under ~/.claude/projects and end up on a shell command line —
// accept only the characters a real id (a UUID) can contain, so a stray file name can't inject.
const SHELL_SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

async function canonical(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/**
 * `cwd` matters: Claude Code resolves a session's own project folder from the *encoded cwd* the
 * process is started with (see `resolveProjectFolder` in `sessionStore.ts`) — for a session whose
 * transcript physically lives under a git worktree's own folder, resuming from anywhere else can
 * fail to find it, the same way the official extension's own panel can show one empty when its
 * active workspace root doesn't match. Passing the session's own `repoRoot` here gives `--resume`
 * the best chance of finding the right folder regardless of what the active VS Code window is.
 */
function resumeInTerminal(sessionId: string, cwd?: string): void {
  if (!SHELL_SAFE_SESSION_ID.test(sessionId)) {
    vscode.window.showErrorMessage(`Switchboard: refusing to resume a session with an unexpected id: ${sessionId}`);
    return;
  }
  const terminal = vscode.window.createTerminal({ name: `Claude: ${sessionId.slice(0, 8)}`, cwd });
  terminal.show();
  // `--resume` takes an OPTIONAL value (commander.js `[value]` syntax) — passing it space-separated
  // is ambiguous and can be parsed as "show the resume picker" with the sessionId as a stray
  // argument, landing on a blank conversation instead of the requested one. `=` is unambiguous.
  terminal.sendText(`claude --resume=${sessionId}`);
}

// Same substring check the official extension uses for its own panels (see deleteSession.ts).
const CLAUDE_PANEL_VIEW_TYPE_FRAGMENT = 'claudeVSCodePanel';

/** Labels of every open Claude Code panel tab, with the active one marked — for the open trace. */
function describeClaudePanels(): string {
  const parts: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE_FRAGMENT)) {
        parts.push(`"${tab.label}"${tab.isActive ? ' (active)' : ''}@col${group.viewColumn}`);
      }
    }
  }
  return parts.length ? parts.join(', ') : '(none)';
}

/**
 * Hands off to the official Claude Code extension's own (undocumented) open command when
 * available, falling back to `claude --resume <id>` in a terminal if it's missing or changes
 * signature in a future update.
 */
export function registerOpenSessionCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  listProvider: SessionListProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.openSession', async (sessionId?: string) => {
      if (!sessionId) {
        output.appendLine('switchboard.openSession invoked without a sessionId — nothing to open.');
        return;
      }

      // Traced on purpose: the official `createPanel` silently just reveals an already-bound panel
      // for the session (no new tab, nothing logged on its side), which from the outside looks
      // identical to "nothing happened". Before/after tab snapshots make the two distinguishable.
      output.appendLine(`open ${sessionId}: Claude panels before = ${describeClaudePanels()}`);

      // The third arg (viewColumn) must stay undefined. The official `createPanel` only runs its
      // "reuse the tab group whose tabs are ALL Claude panels" search when no column is passed; an
      // explicit one is used verbatim. `ViewColumn.Active` therefore dropped the chat into whichever
      // group had focus — and once the Claude group is locked, VS Code pushes an Active-targeted
      // editor back OUT of it (the lock test is `locked && !alreadyContainsThisEditor`).
      await callOfficialCommandOrFallback(
        OFFICIAL_OPEN_COMMAND,
        [sessionId, undefined, undefined],
        () => resumeInTerminal(sessionId),
        output,
      );

      output.appendLine(`open ${sessionId}: Claude panels after  = ${describeClaudePanels()}`);
    }),

    // A deliberate, always-available alternative to the official panel — not just the fallback
    // used when that command is missing. The official panel can come back empty for a session
    // whose repoRoot differs from the currently active workspace (a worktree an agent `cd`ed
    // into): its own folder resolution is outside our control, but launching a plain `--resume`
    // terminal FROM that session's own repoRoot gives the CLI the best chance of finding it.
    vscode.commands.registerCommand('switchboard.resumeInTerminal', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      resumeInTerminal(item.session.sessionId, item.repoRoot);
    }),

    // A session living in another scope's project folder (a git worktree the agent entered).
    // Verified against the official extension 2.1.263: its panel validates a session against a
    // list built with `includeWorktrees: false`, so `editor.open(sessionId)` in THIS window ends in
    // `restore_declined` and a blank, brand-new chat. The same panel in a window rooted at the
    // worktree finds it, because there the worktree IS the project folder. So offer that, plus the
    // terminal, instead of a click that silently produces an empty chat.
    vscode.commands.registerCommand('switchboard.openForeignSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      const primaryLabel = listProvider.primaryScope()?.label ?? 'this workspace';
      const moveHere = `$(arrow-left) Move into "${primaryLabel}" and open here`;
      const inWindow = `$(multiple-windows) Open in a window at "${item.repoLabel}"`;
      const inTerminal = '$(terminal) Resume in Terminal';
      const hereAnyway = '$(comment) Open here anyway';
      const picked = await vscode.window.showQuickPick(
        [
          { label: moveHere, description: 'what Claude Code does on "exit worktree": the chat becomes a normal chat of this workspace' },
          { label: inWindow, description: item.repoRoot },
          { label: inTerminal, description: 'claude --resume from the chat\'s own folder, in this window' },
          { label: hereAnyway, description: 'official panel — shows a blank chat for worktree chats (verified on Claude Code extension 2.1.263)' },
        ],
        { placeHolder: `"${item.session.title}" lives in ${item.repoLabel}; the official panel in this window cannot find it there` },
      );
      if (!picked) {
        return;
      }
      if (picked.label === moveHere) {
        await vscode.commands.executeCommand('switchboard.moveSessionToPrimary', item);
        return;
      }
      if (picked.label === inTerminal) {
        await vscode.commands.executeCommand('switchboard.resumeInTerminal', item);
        return;
      }
      if (picked.label === hereAnyway) {
        await vscode.commands.executeCommand('switchboard.openSession', item.session.sessionId);
        return;
      }
      const pending: PendingOpen = { sessionId: item.session.sessionId, repoRoot: item.repoRoot, requestedAt: Date.now() };
      await context.globalState.update(PENDING_OPEN_KEY, pending);
      output.appendLine(`open ${item.session.sessionId}: handing off to a window at ${item.repoRoot}`);
      // If that folder is already open in another window VS Code focuses it instead of creating one;
      // consumePendingOpen also runs on window focus for exactly that case.
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(item.repoRoot), { forceNewWindow: true });
    }),

    // The one-window answer for a chat Claude Code relocated into a worktree: perform the exact
    // relocation the CLI performs on ExitWorktree, back into this window's primary folder. Every
    // reader then treats it as a plain chat of this workspace — the official panel's list includes
    // it, and its `resume` no longer re-enters the worktree (the last worktree-state is null). If
    // the agent enters the worktree again later, Claude Code moves it there again, and this action
    // is offered again — symmetric with the CLI's own behavior, not a fork or a copy.
    vscode.commands.registerCommand('switchboard.moveSessionToPrimary', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      const primary = listProvider.primaryScope();
      if (!primary) {
        vscode.window.showErrorMessage('Switchboard: this window has no primary workspace folder to move the chat into.');
        return;
      }
      if (!listProvider.isForeignScope(item)) {
        vscode.window.showInformationMessage(`"${item.session.title}" already lives in "${primary.label}".`);
        return;
      }
      // A workspace no chat was ever started in has no project folder yet — create the one Claude
      // Code itself would (its deterministic encoding of the root), exactly as its own relocation does.
      const targetFolder = primary.projectFolder ?? defaultProjectFolder(primary.root);

      // Never move a transcript another process is appending to — the CLI itself only relocates
      // from inside the owning process. Checked twice: before asking, and again after the modal,
      // which can stay open long enough for a process to pick the session up meanwhile.
      const refuseIfLive = async (): Promise<boolean> => {
        const live = await liveSessionIds();
        if (!live.has(item.session.sessionId)) {
          return false;
        }
        vscode.window.showWarningMessage(
          `"${item.session.title}" is open in a running Claude Code process (a terminal or another panel). Close that first, then move it.`,
        );
        return true;
      };
      if (await refuseIfLive()) {
        return;
      }

      const ageSeconds = Math.round((Date.now() - item.session.lastModified) / 1000);
      const recentNote =
        Date.now() - item.session.lastModified < RECENT_WRITE_MS
          ? ` It was written ${ageSeconds}s ago — make sure nothing is still using it.`
          : '';
      const choice = await vscode.window.showWarningMessage(
        `Move "${item.session.title}" from ${item.repoLabel} into "${primary.label}"?`,
        {
          modal: true,
          detail:
            'This is the same move Claude Code makes when a session exits a worktree. The chat becomes a normal chat of this workspace and opens in this window. ' +
            'If the agent enters the worktree again later, Claude Code moves it back there.' +
            recentNote,
        },
        'Move',
      );
      if (choice !== 'Move') {
        return;
      }
      if (await refuseIfLive()) {
        return;
      }

      try {
        const result = await relocateSession(item.session.filePath, item.session.sessionId, targetFolder, primary.root);
        output.appendLine(
          `moved ${item.session.sessionId} from ${item.session.filePath} to ${result.newFilePath}` +
            (result.setAside ? ` (existing destination set aside at ${result.setAside})` : '') +
            (result.sidecarMoved ? ' (sidecar dir moved)' : '') +
            (result.sidecarSetAside ? ` (existing sidecar dir set aside at ${result.sidecarSetAside})` : ''),
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Could not move "${item.session.title}": ${String(err)}`);
        output.appendLine(`move ${item.session.sessionId} failed: ${String(err)}`);
        return;
      }

      // The target folder may have just been created — re-discover so it is scoped and watched.
      await listProvider.refresh({ rediscover: true });
      await vscode.commands.executeCommand('switchboard.openSession', item.session.sessionId);
    }),
  );
}

/**
 * The receiving side of `switchboard.openForeignSession`: in the window whose primary folder the
 * request targets, open the session through the normal path (the official panel's list includes
 * it here). Checked at activation and again whenever this window gains focus, so both a brand-new
 * window and an already-open one that VS Code merely focused pick it up.
 */
export function consumePendingOpen(
  context: vscode.ExtensionContext,
  primaryWorkspaceRoot: string,
  output: vscode.OutputChannel,
): void {
  let handling = false;
  const check = async (): Promise<void> => {
    if (handling) {
      return;
    }
    const raw = context.globalState.get<unknown>(PENDING_OPEN_KEY);
    if (!isPendingOpen(raw)) {
      return;
    }
    // Claimed before the first await: activation and an immediate focus event call this back to
    // back, and both would otherwise pass the guard above and open the session twice.
    handling = true;
    let scheduled = false;
    try {
      const [primary, target] = await Promise.all([canonical(primaryWorkspaceRoot), canonical(raw.repoRoot)]);
      if (!matchesPendingOpen(raw, primary, target, Date.now())) {
        return;
      }
      await context.globalState.update(PENDING_OPEN_KEY, undefined);
      output.appendLine(`pending open ${raw.sessionId}: this window is rooted at ${raw.repoRoot} — opening in ${PENDING_OPEN_ACTIVATION_DELAY_MS}ms`);
      scheduled = true;
      setTimeout(() => {
        void (async () => {
          try {
            await vscode.commands.executeCommand('switchboard.openSession', raw.sessionId);
          } finally {
            handling = false;
          }
        })();
      }, PENDING_OPEN_ACTIVATION_DELAY_MS);
    } finally {
      if (!scheduled) {
        handling = false;
      }
    }
  };

  void check();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void check();
      }
    }),
  );
}
