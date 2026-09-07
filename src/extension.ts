import * as vscode from 'vscode';
import { resolveProjectFolder, ResolvedScope } from './sessionStore';
import { SessionListProvider, describeScopes } from './sessionListProvider';
import { discoverScopes } from './repoScopes';
import { registerOpenSessionCommand, consumePendingOpen } from './commands/openSession';
import { registerNewSessionCommand } from './commands/newSession';
import { registerDeleteSessionCommand } from './commands/deleteSession';
import { registerPinCommands } from './commands/pinSession';
import { registerArchiveCommands } from './commands/archiveSession';
import { registerTagCommands } from './commands/tagSession';
import { registerSearchCommands } from './commands/searchSessions';
import { registerMoreActionsCommand } from './commands/moreActions';
import { registerRenameSessionCommand } from './commands/renameSession';
import { registerBackgroundAgentCommands } from './commands/backgroundAgentActions';
import { registerForkSessionCommand } from './commands/forkSession';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // `log: true` makes VS Code persist this channel to its logs directory (exthost/nimrodk.switchboard/),
  // so what Switchboard did during an open can be read back after the fact — a plain channel
  // lives only in the Output panel and is gone on reload.
  const output = vscode.window.createOutputChannel('Switchboard', { log: true });
  context.subscriptions.push(output);

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    output.appendLine('No workspace folder open — Switchboard has nothing to show.');
    return;
  }

  // Every open workspace folder, plus any git worktrees associated with each one — a session can
  // live under a worktree's own Claude Code project folder even when the agent started (and spent
  // most of its turns) in the main repo, and a multi-root workspace can simply have more than one
  // real repo open at once. Scanning only `folders[0]` (the old behavior) made every session
  // outside that one folder invisible, with no error — see PLAN.md "repo scoping" round.
  // Also handed to the list provider, which re-runs it on refresh: a worktree added or a project
  // folder created after activation must show up without a reload.
  const resolveScopes = async (): Promise<ResolvedScope[]> => {
    const current = vscode.workspace.workspaceFolders ?? [];
    const discovered = await discoverScopes(current.map((f) => ({ root: f.uri.fsPath, name: f.name })));
    return Promise.all(discovered.map(async (scope) => ({ ...scope, projectFolder: await resolveProjectFolder(scope.root) })));
  };
  const scopes = await resolveScopes();

  const resolvedCount = scopes.filter((s) => s.projectFolder).length;
  if (resolvedCount === 0) {
    const message = `Switchboard could not find a Claude Code chat history folder for this workspace.`;
    output.appendLine(`${message} (scopes checked: ${scopes.map((s) => s.root).join(', ')})`);
    vscode.window.showWarningMessage(message);
  } else {
    output.appendLine(`Resolved ${resolvedCount}/${scopes.length} repo scope(s): ${describeScopes(scopes)}`);
  }

  const listProvider = new SessionListProvider(scopes, resolveScopes, (line) => output.appendLine(line));
  context.subscriptions.push(listProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('switchboardSessions', listProvider),
  );

  const ACTION_COMMANDS: Record<string, string> = {
    open: 'switchboard.openSession',
    pin: 'switchboard.pinSession',
    unpin: 'switchboard.unpinSession',
    archive: 'switchboard.archiveSession',
    unarchive: 'switchboard.unarchiveSession',
    rename: 'switchboard.renameSession',
    more: 'switchboard.showItemActions',
  };

  context.subscriptions.push(
    listProvider.onDidRequestAction(async ({ action, sessionId }) => {
      const command = ACTION_COMMANDS[action];
      if (!command) {
        return;
      }
      if (action === 'open') {
        listProvider.markReviewed(sessionId);
        listProvider.refresh();
        // A chat living in another scope's folder can't be opened by the official panel in this
        // window (see openForeignSession) — route it to the chooser instead of a blank chat.
        const opened = await listProvider.resolveItem(sessionId);
        if (opened && listProvider.isForeignScope(opened)) {
          await vscode.commands.executeCommand('switchboard.openForeignSession', opened);
        } else {
          await vscode.commands.executeCommand(command, sessionId);
        }
        return;
      }
      const item = await listProvider.resolveItem(sessionId);
      if (item) {
        await vscode.commands.executeCommand(command, item);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.refresh', async () => listProvider.refresh({ rediscover: true })),
    vscode.commands.registerCommand('switchboard.debugLogSessions', async () => {
      const sessions = await listProvider.getAllScopedSessions();
      output.appendLine(`Found ${sessions.length} session(s) across ${listProvider.getScopes().length} scope(s):`);
      for (const s of sessions) {
        output.appendLine(`  [${s.repoLabel}] ${s.sessionId} — "${s.title}" (last activity ${new Date(s.lastActivity).toISOString()})`);
      }
      output.show();
    }),
  );

  // "New chat"/"new background agent" always starts in the primary workspace folder — there is no
  // UI yet to ask which scope a brand-new chat should belong to, and defaulting to the folder VS
  // Code itself treats as primary is the least surprising choice.
  const primaryWorkspaceRoot = folders[0].uri.fsPath;

  registerOpenSessionCommand(context, output, listProvider);
  registerNewSessionCommand(context, primaryWorkspaceRoot, output);
  registerDeleteSessionCommand(context, listProvider, output);
  registerPinCommands(context, listProvider);
  registerArchiveCommands(context, listProvider, output);
  registerTagCommands(context, listProvider);
  registerSearchCommands(context, listProvider);
  registerMoreActionsCommand(context, listProvider);
  registerRenameSessionCommand(context, listProvider);
  registerBackgroundAgentCommands(context, listProvider, output);
  registerForkSessionCommand(context, listProvider, output);

  consumePendingOpen(context, primaryWorkspaceRoot, output);
}

export function deactivate(): void {}
