import * as vscode from 'vscode';
import { callOfficialCommandOrFallback } from './officialCommandBridge';

const OFFICIAL_OPEN_COMMAND = 'claude-vscode.editor.open';

function resumeInTerminal(sessionId: string): void {
  const terminal = vscode.window.createTerminal(`Claude: ${sessionId.slice(0, 8)}`);
  terminal.show();
  // `--resume` takes an OPTIONAL value (commander.js `[value]` syntax) — passing it space-separated
  // is ambiguous and can be parsed as "show the resume picker" with the sessionId as a stray
  // argument, landing on a blank conversation instead of the requested one. `=` is unambiguous.
  terminal.sendText(`claude --resume=${sessionId}`);
}

/**
 * Hands off to the official Claude Code extension's own (undocumented) open command when
 * available, falling back to `claude --resume <id>` in a terminal if it's missing or changes
 * signature in a future update.
 */
export function registerOpenSessionCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.openSession', async (sessionId?: string) => {
      if (!sessionId) {
        output.appendLine('switchboard.openSession invoked without a sessionId — nothing to open.');
        return;
      }

      // The third arg (viewColumn) must stay undefined. The official `createPanel` only runs its
      // "reuse the tab group whose tabs are ALL Claude panels" search when no column is passed; an
      // explicit one is used verbatim. `ViewColumn.Active` therefore dropped the chat into whichever
      // group had focus — and once the Claude group is locked, VS Code pushes an Active-targeted
      // editor back OUT of it (the lock test is `locked && !alreadyContainsThisEditor`).
      await callOfficialCommandOrFallback(
        OFFICIAL_OPEN_COMMAND,
        [sessionId, undefined, undefined],
        () => resumeInTerminal(sessionId),
        output,
      );
    }),
  );
}
