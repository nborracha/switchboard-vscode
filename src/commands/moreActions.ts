import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';

interface Action {
  label: string;
  command: string;
}

/**
 * The "..." icon / right-click action on each row. Pin/Archive have their own dedicated
 * always-reachable icons, so this menu covers the rest: open, tag management, and delete.
 */
export function registerMoreActionsCommand(context: vscode.ExtensionContext, listProvider: SessionListProvider): void {
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
      if (listProvider.isForeignScope(item)) {
        const primaryLabel = listProvider.primaryScope()?.label ?? 'this workspace';
        actions.push({ label: `$(arrow-left) Move into "${primaryLabel}"`, command: 'switchboard.moveSessionToPrimary' });
      }
      actions.push(
        // Plain `claude --resume` in a terminal started from the session's own repo root — a
        // panel-free way in that works for every chat, including one relocated into a worktree,
        // which the official panel in this window cannot open (verified on extension 2.1.263).
        { label: '$(terminal) Resume in Terminal', command: 'switchboard.resumeInTerminal' },
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
        if (listProvider.isForeignScope(item)) {
          await vscode.commands.executeCommand('switchboard.openForeignSession', item);
        } else {
          await vscode.commands.executeCommand(picked.command, item.session.sessionId);
        }
      } else {
        await vscode.commands.executeCommand(picked.command, item);
      }
    }),
  );
}
