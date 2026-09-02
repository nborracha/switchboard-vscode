import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { renameSession } from '../sessionStore';

export function registerRenameSessionCommand(context: vscode.ExtensionContext, listProvider: SessionListProvider): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.renameSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }

      const newTitle = await vscode.window.showInputBox({
        prompt: 'Rename chat',
        value: item.session.title,
        validateInput: (value) => (value.trim() ? undefined : 'Title cannot be empty'),
      });
      if (!newTitle?.trim() || newTitle.trim() === item.session.title) {
        return;
      }

      await renameSession(item.session.filePath, item.session.sessionId, newTitle.trim());
      listProvider.refresh();
    }),
  );
}
