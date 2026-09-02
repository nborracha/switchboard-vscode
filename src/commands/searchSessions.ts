import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { listSessions, ParsedSession } from '../sessionStore';
import { MetadataStore } from '../metadataStore';
import { readHiddenSessionIds } from '../hiddenSessions';
import { SessionListProvider } from '../sessionListProvider';

async function fileContainsText(filePath: string, needleLower: string): Promise<string | undefined> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const idx = line.toLowerCase().indexOf(needleLower);
      if (idx !== -1) {
        return line.slice(Math.max(0, idx - 40), idx + needleLower.length + 40);
      }
    }
  } catch {
    // transcript became unreadable mid-scan — treat as no match rather than aborting the search
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}

export function registerSearchCommands(
  context: vscode.ExtensionContext,
  metadataStore: MetadataStore,
  getProjectFolder: () => string | undefined,
  listProvider: SessionListProvider,
): void {
  context.subscriptions.push(
    // The list itself now has an inline filter box (title/first-prompt/tag, live as you type), so
    // this command's job is just to reveal the view and focus that box — no more separate
    // QuickPick duplicating what the sidebar can already do inline, and filtering there leaves
    // every row's pin/archive/rename action reachable without first having to open the chat.
    vscode.commands.registerCommand('switchboard.search', async () => {
      await listProvider.focusSearch();
    }),

    vscode.commands.registerCommand('switchboard.searchContent', async () => {
      const projectFolder = getProjectFolder();
      if (!projectFolder) {
        return;
      }

      const query = await vscode.window.showInputBox({
        prompt: 'Search full chat content (slower — scans all transcripts)',
      });
      if (!query?.trim()) {
        return;
      }

      const needleLower = query.trim().toLowerCase();
      const [allSessions, metadata, hiddenIds] = await Promise.all([
        listSessions(projectFolder),
        metadataStore.getAll(),
        readHiddenSessionIds(),
      ]);
      const sessions = allSessions.filter((s) => !hiddenIds.has(s.sessionId));

      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Searching chat content...' },
        () =>
          Promise.all(
            sessions.map(async (session) => {
              const snippet = await fileContainsText(session.filePath, needleLower);
              return snippet ? { session, snippet } : undefined;
            }),
          ),
      );
      const matches = results.filter((m): m is { session: ParsedSession; snippet: string } => !!m);

      if (matches.length === 0) {
        vscode.window.showInformationMessage(`No chats contain "${query}"`);
        return;
      }

      const meta = (session: ParsedSession) => metadata[session.sessionId] ?? {};
      const picked = await vscode.window.showQuickPick(
        matches.map(({ session, snippet }) => ({
          label: session.title,
          description: meta(session).tags?.length ? meta(session).tags!.join(', ') : undefined,
          detail: snippet,
          iconPath: meta(session).pinned ? new vscode.ThemeIcon('pinned') : undefined,
          sessionId: session.sessionId,
        })),
        { placeHolder: `${matches.length} chat(s) matched`, matchOnDescription: true, matchOnDetail: true },
      );
      if (picked) {
        await vscode.commands.executeCommand('switchboard.openSession', picked.sessionId);
      }
    }),
  );
}
