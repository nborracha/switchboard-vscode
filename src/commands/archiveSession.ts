import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { MetadataStore } from '../metadataStore';
import { stopBackgroundAgentSafely } from '../backgroundAgents';

export function registerArchiveCommands(
  context: vscode.ExtensionContext,
  listProvider: SessionListProvider,
  metadataStore: MetadataStore,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.archiveSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      // Pinned wins over archived in the list's bucket priority (see SessionListProvider), so an
      // archived-but-still-pinned session would silently stay in Pinned instead of moving to
      // Archived — unpin it here so the action visibly does what it says.
      if (item.pinned) {
        await metadataStore.setPinned(item.session.sessionId, false);
      }
      await metadataStore.setArchived(item.session.sessionId, true);

      // Archiving is a deliberate "I'm done with this" signal — the same one that should free a
      // background agent, rather than leaving it running indefinitely with nothing watching it.
      if (item.backgroundAgentId) {
        await stopBackgroundAgentSafely(item.backgroundAgentId, output);
      }

      listProvider.refresh();
    }),
    vscode.commands.registerCommand('switchboard.unarchiveSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      await metadataStore.setArchived(item.session.sessionId, false);
      listProvider.refresh();
    }),
  );
}
