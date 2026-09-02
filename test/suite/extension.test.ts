import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXPECTED_COMMANDS = [
  'switchboard.refresh',
  'switchboard.openSession',
  'switchboard.newSession',
  'switchboard.deleteSession',
  'switchboard.pinSession',
  'switchboard.unpinSession',
  'switchboard.archiveSession',
  'switchboard.unarchiveSession',
  'switchboard.manageTags',
  'switchboard.renameSession',
  'switchboard.forkSession',
  'switchboard.showItemActions',
  'switchboard.attachBackgroundAgent',
  'switchboard.stopBackgroundAgent',
  'switchboard.search',
  'switchboard.searchContent',
  'switchboard.debugLogSessions',
];

suite('Switchboard (Extension Host)', () => {
  test('activates and registers every contributed command', async () => {
    const ext = vscode.extensions.getExtension('nimrodk.switchboard');
    assert.ok(ext, 'extension should be present in this test profile');

    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(cmd), `command "${cmd}" should be registered`);
    }
  });

  test('debugLogSessions runs the full sessionStore -> output-channel pipeline against fixture data', async () => {
    await vscode.commands.executeCommand('switchboard.debugLogSessions');
  });

  test('refresh runs the full buildData pipeline, including the background-agent lookup, without throwing', async () => {
    // The webview is never actually shown in this headless test, so resolveWebviewView never
    // fires — refresh() still runs buildData() (and therefore listRunningBackgroundAgents, a real
    // `claude agents --json --all` subprocess call) even with no view to post the result to.
    await vscode.commands.executeCommand('switchboard.refresh');
  });

  test('openSession falls back to a terminal when the official Claude Code extension is absent', async () => {
    // This test profile has no other extensions installed, so this exercises the
    // terminal-resume fallback branch end-to-end without throwing.
    await vscode.commands.executeCommand('switchboard.openSession', 'fixture-session-1');
  });

  // newSession is intentionally not exercised end-to-end here: it now opens a QuickPick
  // ("New Chat" vs "New Background Agent") before doing anything else, so invoking it headlessly
  // would hang waiting for a selection nothing in this test can answer. Its registration is still
  // covered by the command-list assertion above.
});
