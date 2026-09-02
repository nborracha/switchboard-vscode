import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';

/**
 * Full Extension Host run — always against a throwaway CLAUDE_CONFIG_DIR /
 * CLAUDE_CHAT_MANAGER_HOME, never the developer's real ~/.claude data.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspacePath = path.resolve(extensionDevelopmentPath, 'fixtures/workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-test-'));
  const claudeConfigDir = path.join(tmpRoot, 'claude-home');
  const chatManagerHome = path.join(tmpRoot, 'chat-manager-home');
  const projectFolder = path.join(claudeConfigDir, 'projects', 'fixture-workspace');
  await fs.mkdir(projectFolder, { recursive: true });

  const iso = new Date().toISOString();

  const session1 = [
    { type: 'mode', mode: 'normal', sessionId: 'fixture-session-1' },
    {
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'Fix the login bug' },
      timestamp: iso,
      cwd: workspacePath,
      gitBranch: 'main',
      sessionId: 'fixture-session-1',
    },
    { type: 'ai-title', aiTitle: 'Fix login bug', sessionId: 'fixture-session-1' },
  ];

  const session2 = [
    {
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'Add dark mode toggle' },
      timestamp: iso,
      cwd: workspacePath,
      gitBranch: 'main',
      sessionId: 'fixture-session-2',
    },
    { type: 'custom-title', customTitle: 'Dark mode toggle', sessionId: 'fixture-session-2' },
  ];

  await fs.writeFile(
    path.join(projectFolder, 'fixture-session-1.jsonl'),
    session1.map((l) => JSON.stringify(l)).join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(projectFolder, 'fixture-session-2.jsonl'),
    session2.map((l) => JSON.stringify(l)).join('\n'),
    'utf8',
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
      extensionTestsEnv: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CHAT_MANAGER_HOME: chatManagerHome,
        // Inherited from the outer shell in some sandboxes; forces any spawned Electron binary
        // into headless-Node mode instead of launching the actual app, which breaks the test run.
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Extension test run failed:', err);
  process.exit(1);
});
