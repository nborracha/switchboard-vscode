import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';

export function registerPinCommands(context: vscode.ExtensionContext, listProvider: SessionListProvider): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.pinSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      await listProvider.metadataStoreForItem(item).setPinned(item.session.sessionId, true);
      listProvider.refresh();
    }),
    vscode.commands.registerCommand('switchboard.unpinSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      await listProvider.metadataStoreForItem(item).setPinned(item.session.sessionId, false);
      listProvider.refresh();
    }),
  );
}
