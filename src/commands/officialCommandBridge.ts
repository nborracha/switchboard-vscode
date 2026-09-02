import * as vscode from 'vscode';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The official extension isn't installed/uninstalled mid-session, so a positive result never
// needs re-checking; a negative one can just mean it hadn't finished activating yet (both
// extensions activate on `onStartupFinished`, a real race), so only "found it" is cached.
const availableCache = new Map<string, boolean>();

async function isCommandAvailable(commandId: string): Promise<boolean> {
  if (!availableCache.get(commandId)) {
    const available = await vscode.commands.getCommands(true);
    availableCache.set(commandId, available.includes(commandId));
  }
  return !!availableCache.get(commandId);
}

/**
 * Calls an official Claude Code extension command with a one-retry hedge against the
 * `onStartupFinished` activation race, falling back to a caller-provided action if the command
 * still isn't reachable or throws.
 */
export async function callOfficialCommandOrFallback(
  commandId: string,
  args: unknown[],
  fallback: () => void,
  output: vscode.OutputChannel,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await sleep(300);
    }

    if (await isCommandAvailable(commandId)) {
      try {
        await vscode.commands.executeCommand(commandId, ...args);
        return;
      } catch (err) {
        output.appendLine(`"${commandId}" failed (attempt ${attempt + 1}): ${String(err)}`);
      }
    }
  }

  output.appendLine(`"${commandId}" unavailable — falling back.`);
  fallback();
}
