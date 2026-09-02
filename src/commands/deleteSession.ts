import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { MetadataStore } from '../metadataStore';
import { fileHistoryDir, invalidateSession } from '../sessionStore';
import { stopBackgroundAgentSafely } from '../backgroundAgents';

const RECENT_THRESHOLD_MS = 2 * 60 * 1000;

// Matches the exact substring check the official extension uses internally to find its own open
// panels (`l.input.viewType.includes("claudeVSCodePanel")`) — the Tab API exposes a prefixed
// viewType string, not the raw one used at registration time.
const CLAUDE_PANEL_VIEW_TYPE_FRAGMENT = 'claudeVSCodePanel';

/**
 * Best-effort: closes the open Claude Code editor tab if deleting this session.
 *
 * The official extension gives us no public way to know which open tab (if any) corresponds to
 * a given sessionId — every Claude Code panel shares the same generic webview viewType and title
 * ("Claude Code"), and the internal sessionId->panel map is private state we can't read. So this
 * only acts when exactly one Claude Code panel is open at all: closing it is a safe, high-
 * confidence guess in that case, but with two or more open we have no signal to disambiguate and
 * deliberately do nothing rather than risk closing an unrelated chat.
 */
async function closeSoleClaudePanelTab(): Promise<void> {
  const claudeTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE_FRAGMENT));

  if (claudeTabs.length === 1) {
    await vscode.window.tabGroups.close(claudeTabs[0]);
  }
}

/**
 * Real deletion — the official extension's own "delete" only calls `settings.hideSession()`
 * (a soft hide), it never removes the transcript from disk. This removes the `.jsonl`, the
 * `<sessionId>/` subagent subfolder if present, and the session's `~/.claude/file-history/<id>/`
 * snapshots (confirmed session-keyed on this machine).
 */
export function registerDeleteSessionCommand(
  context: vscode.ExtensionContext,
  listProvider: SessionListProvider,
  metadataStore: MetadataStore,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.deleteSession', async (item?: SessionItem) => {
      if (!item) {
        return;
      }

      const { session } = item;
      const recentlyActive = Date.now() - session.lastActivity < RECENT_THRESHOLD_MS;
      const warning = recentlyActive
        ? `"${session.title}" had activity in the last 2 minutes — it may be your current active chat. Delete anyway? This cannot be undone.`
        : `Delete "${session.title}" permanently? This removes the transcript from disk and cannot be undone.`;

      const choice = await vscode.window.showWarningMessage(warning, { modal: true }, 'Delete');
      if (choice !== 'Delete') {
        return;
      }

      // Stop a live background agent before deleting its transcript — otherwise it could still be
      // writing to the very file we're about to remove.
      if (item.backgroundAgentId) {
        await stopBackgroundAgentSafely(item.backgroundAgentId, output);
      }

      try {
        await fsp.unlink(session.filePath);
      } catch (err) {
        output.appendLine(`Failed to delete ${session.filePath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Could not delete "${session.title}": ${String(err)}`);
        return;
      }

      invalidateSession(session.filePath);

      if (session.hasSubagents) {
        const subDir = path.join(path.dirname(session.filePath), session.sessionId);
        await fsp.rm(subDir, { recursive: true, force: true });
      }

      await fsp.rm(fileHistoryDir(session.sessionId), { recursive: true, force: true });
      await metadataStore.removeSession(session.sessionId);

      try {
        await closeSoleClaudePanelTab();
      } catch (err) {
        output.appendLine(`Could not close the Claude Code tab after delete: ${String(err)}`);
      }

      output.appendLine(`Deleted session ${session.sessionId} ("${session.title}")`);
      listProvider.refresh();
    }),
  );
}
