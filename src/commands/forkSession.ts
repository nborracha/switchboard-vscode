import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { forkSession, renameSession } from '../sessionStore';

/**
 * Duplicates a session as a new, independent one — lets you fork right after the agent's last
 * reply, which the official UI doesn't support (it only forks from one of your own messages).
 */
export function registerForkSessionCommand(
  context: vscode.ExtensionContext,
  listProvider: SessionListProvider,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.forkSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }

      try {
        const { newSessionId, newFilePath } = await forkSession(item.session.filePath, item.session.sessionId);
        await renameSession(newFilePath, newSessionId, `${item.session.title} (fork)`);

        output.appendLine(`Forked "${item.session.title}" (${item.session.sessionId}) -> ${newSessionId}`);
        listProvider.refresh();
        await vscode.commands.executeCommand('switchboard.openSession', newSessionId);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to fork "${item.session.title}": ${String(err)}`);
        output.appendLine(`Fork failed: ${String(err)}`);
      }
    }),
  );
}
