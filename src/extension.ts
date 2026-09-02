import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { resolveProjectFolder, listSessions } from './sessionStore';
import { MetadataStore } from './metadataStore';
import { SessionListProvider } from './sessionListProvider';
import { registerOpenSessionCommand } from './commands/openSession';
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

// Derived from the full workspace path (not just its resolved Claude Code project folder, which
// can fail to resolve, or its basename, which two unrelated repos can share) so our own pin/tag
// sidecar store never collides across workspaces regardless of whether resolution succeeds.
function workspaceIdentity(workspaceRoot: string): string {
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 8);
  return `${path.basename(workspaceRoot)}-${hash}`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Switchboard');
  context.subscriptions.push(output);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    output.appendLine('No workspace folder open — Switchboard has nothing to show.');
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const projectFolder = await resolveProjectFolder(workspaceRoot);

  if (projectFolder) {
    output.appendLine(`Resolved Claude Code project folder: ${projectFolder}`);
  } else {
    const message = `Switchboard could not find a Claude Code chat history folder for this workspace.`;
    output.appendLine(`${message} (workspace root: ${workspaceRoot})`);
    vscode.window.showWarningMessage(message);
  }

  const metadataStore = new MetadataStore(workspaceIdentity(workspaceRoot));

  const listProvider = new SessionListProvider(projectFolder, workspaceRoot, metadataStore);
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
        await vscode.commands.executeCommand(command, sessionId);
        return;
      }
      const item = await listProvider.resolveItem(sessionId);
      if (item) {
        await vscode.commands.executeCommand(command, item);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.refresh', async () => listProvider.refresh()),
    vscode.commands.registerCommand('switchboard.debugLogSessions', async () => {
      if (!projectFolder) {
        output.appendLine('No project folder resolved.');
        output.show();
        return;
      }
      const sessions = await listSessions(projectFolder);
      output.appendLine(`Found ${sessions.length} session(s):`);
      for (const s of sessions) {
        output.appendLine(`  ${s.sessionId} — "${s.title}" (last activity ${new Date(s.lastActivity).toISOString()})`);
      }
      output.show();
    }),
  );

  registerOpenSessionCommand(context, output);
  registerNewSessionCommand(context, workspaceRoot, output);
  registerDeleteSessionCommand(context, listProvider, metadataStore, output);
  registerPinCommands(context, listProvider, metadataStore);
  registerArchiveCommands(context, listProvider, metadataStore, output);
  registerTagCommands(context, listProvider, metadataStore);
  registerSearchCommands(context, metadataStore, () => projectFolder, listProvider);
  registerMoreActionsCommand(context);
  registerRenameSessionCommand(context, listProvider);
  registerBackgroundAgentCommands(context, listProvider, output);
  registerForkSessionCommand(context, listProvider, output);
}

export function deactivate(): void {}
