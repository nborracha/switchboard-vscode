import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { callOfficialCommandOrFallback } from './officialCommandBridge';

const execFileAsync = promisify(execFile);

// `claude-vscode.newConversation`'s own handler is just `notifyCreateNewConversation()` — it
// notifies an ALREADY-OPEN panel to reset itself, it doesn't create one. With no panel open (the
// common case when clicking "+"), that's a silent no-op. `editor.open` (the same command we use
// to resume an existing session) calls `createPanel(sessionId, ...)` directly, and that function
// only checks for an existing panel `if (sessionId)` — passing `undefined` skips straight to
// creating a brand-new one unconditionally, which is the actual "new chat" behavior we want.
const OFFICIAL_OPEN_COMMAND = 'claude-vscode.editor.open';

function newSessionInTerminal(): void {
  const terminal = vscode.window.createTerminal('Claude: New');
  terminal.show();
  terminal.sendText('claude');
}

function attachInTerminal(id: string): void {
  const terminal = vscode.window.createTerminal(`Claude: ${id}`);
  terminal.show();
  terminal.sendText(`claude attach ${id}`);
}

async function startBackgroundAgent(workspaceRoot: string, output: vscode.OutputChannel): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    prompt: 'What should this background agent do?',
    placeHolder: 'e.g. "Investigate the flaky checkout test and propose a fix"',
  });
  if (!prompt?.trim()) {
    return;
  }

  try {
    const { stdout } = await execFileAsync('claude', ['--bg', prompt.trim()], { cwd: workspaceRoot });
    output.appendLine(stdout);

    const id = stdout.match(/backgrounded · ([a-f0-9]+)/)?.[1];
    if (!id) {
      vscode.window.showInformationMessage('Background agent started.');
      return;
    }

    const choice = await vscode.window.showInformationMessage(`Background agent ${id} started.`, 'Attach in Terminal');
    if (choice === 'Attach in Terminal') {
      attachInTerminal(id);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to start background agent: ${String(err)}`);
    output.appendLine(`claude --bg failed: ${String(err)}`);
  }
}

/** The "+" (New Agent) action — either the official extension's own new-conversation panel, or a detached `claude --bg` agent that survives closing any tab. */
export function registerNewSessionCommand(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.newSession', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(comment) New Chat', mode: 'panel' as const },
          {
            label: '$(server-process) New Background Agent',
            detail: 'Keeps running even if you close its tab — check on it or add follow-ups anytime via "Attach"',
            mode: 'background' as const,
          },
        ],
        { placeHolder: 'Start a new Claude Code session' },
      );
      if (!picked) {
        return;
      }

      if (picked.mode === 'background') {
        await startBackgroundAgent(workspaceRoot, output);
        return;
      }

      // viewColumn stays undefined for the same reason as in `openSession.ts` — it is what lets the
      // official `createPanel` place the new chat in the existing all-Claude tab group.
      await callOfficialCommandOrFallback(
        OFFICIAL_OPEN_COMMAND,
        [undefined, undefined, undefined],
        newSessionInTerminal,
        output,
      );
    }),
  );
}
