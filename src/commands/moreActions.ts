import * as vscode from 'vscode';
import { SessionItem } from '../sessionListProvider';

interface Action {
  label: string;
  command: string;
}

/**
 * The "..." icon / right-click action on each row. Pin/Archive have their own dedicated
 * always-reachable icons, so this menu covers the rest: open, tag management, and delete.
 */
export function registerMoreActionsCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.showItemActions', async (item?: SessionItem) => {
      if (!item) {
        return;
      }

      const actions: Action[] = [{ label: '$(comment) Open', command: 'switchboard.openSession' }];
      if (item.backgroundAgentId) {
        actions.push(
          { label: '$(terminal) Attach in Terminal', command: 'switchboard.attachBackgroundAgent' },
          { label: '$(debug-stop) Stop Background Agent', command: 'switchboard.stopBackgroundAgent' },
        );
      }
      actions.push(
        { label: '$(repo-forked) Fork', command: 'switchboard.forkSession' },
        { label: '$(tag) Manage Tags', command: 'switchboard.manageTags' },
        { label: '$(trash) Delete', command: 'switchboard.deleteSession' },
      );

      const placeHolder = item.hidden ? `${item.session.title}  (hidden by Claude Code)` : item.session.title;
      const picked = await vscode.window.showQuickPick(actions, { placeHolder });
      if (!picked) {
        return;
      }

      if (picked.command === 'switchboard.openSession') {
        await vscode.commands.executeCommand(picked.command, item.session.sessionId);
      } else {
        await vscode.commands.executeCommand(picked.command, item);
      }
    }),
  );
}
