import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { stopBackgroundAgent } from '../backgroundAgents';

export function registerBackgroundAgentCommands(
  context: vscode.ExtensionContext,
  listProvider: SessionListProvider,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.attachBackgroundAgent', (item?: SessionItem) => {
      if (item?.backgroundAgentId) {
        const terminal = vscode.window.createTerminal(`Claude: ${item.backgroundAgentId}`);
        terminal.show();
        terminal.sendText(`claude attach ${item.backgroundAgentId}`);
      }
    }),

    vscode.commands.registerCommand('switchboard.stopBackgroundAgent', async (item?: SessionItem) => {
      if (!item?.backgroundAgentId) {
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Stop the background agent for "${item.session.title}"? It will no longer be reachable via Attach.`,
        { modal: true },
        'Stop',
      );
      if (choice !== 'Stop') {
        return;
      }

      try {
        await stopBackgroundAgent(item.backgroundAgentId);
        output.appendLine(`Stopped background agent ${item.backgroundAgentId} ("${item.session.title}")`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop background agent: ${String(err)}`);
      }
      listProvider.refresh();
    }),
  );
}
