import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function withFixture(fn: (opts: { claudeHome: string; workspaceRoot: string }) => Promise<void>): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-unit-'));
  const claudeHome = path.join(tmpRoot, 'claude-home');
  const workspaceRoot = path.join(tmpRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    await fn({ claudeHome, workspaceRoot });
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

suite('sessionStore', () => {
  test('resolveProjectFolder matches via the cwd field embedded in a transcript', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { resolveProjectFolder } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'some-encoded-name');
      await fs.mkdir(projectFolder, { recursive: true });
      await fs.writeFile(
        path.join(projectFolder, 'abc.jsonl'),
        `${JSON.stringify({ type: 'user', cwd: workspaceRoot, message: { role: 'user', content: 'hi' } })}\n`,
        'utf8',
      );

      const resolved = await resolveProjectFolder(workspaceRoot);
      assert.strictEqual(resolved, projectFolder);
    });
  });

  test('resolveProjectFolder falls back to naive path encoding when no cwd hint matches', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { resolveProjectFolder } = await import('../../src/sessionStore');
      const naiveName = workspaceRoot.replace(/[/\\]/g, '-');
      const projectFolder = path.join(claudeHome, 'projects', naiveName);
      await fs.mkdir(projectFolder, { recursive: true });

      const resolved = await resolveProjectFolder(workspaceRoot);
      assert.strictEqual(resolved, projectFolder);
    });
  });

  test('listSessions prioritizes custom-title over ai-title over the first user prompt', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });

      const lines = [
        { type: 'user', isMeta: false, cwd: workspaceRoot, message: { role: 'user', content: 'raw first prompt' } },
        { type: 'ai-title', aiTitle: 'AI generated title' },
        { type: 'custom-title', customTitle: 'User renamed title' },
      ];
      await fs.writeFile(path.join(projectFolder, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].title, 'User renamed title');
      assert.strictEqual(sessions[0].firstPrompt, 'raw first prompt');
    });
  });

  test('listSessions falls back to the first real user message, skipping command-echo noise', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });

      const lines = [
        {
          type: 'user',
          isMeta: false,
          cwd: workspaceRoot,
          message: { role: 'user', content: '<command-name>/clear</command-name>' },
        },
        { type: 'user', isMeta: false, cwd: workspaceRoot, message: { role: 'user', content: 'the real first message' } },
      ];
      await fs.writeFile(path.join(projectFolder, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions[0].title, 'the real first message');
    });
  });

  test('listSessions skips a lone IDE-context block, keeping the sessionId fallback', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });

      const lines = [
        {
          type: 'user',
          isMeta: false,
          cwd: workspaceRoot,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<ide_opened_file>The user opened the file /some/file.md in the IDE. This may or may not be related to the current task.</ide_opened_file>',
              },
            ],
          },
        },
      ];
      await fs.writeFile(path.join(projectFolder, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions[0].title, 'sess', 'a lone IDE-context block is not a real prompt — falls back to sessionId, not the block text');
      assert.strictEqual(sessions[0].firstPrompt, undefined);
    });
  });

  test('listSessions picks the real prompt over a leading IDE-context block in the same message', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });

      const lines = [
        {
          type: 'user',
          isMeta: false,
          cwd: workspaceRoot,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '<ide_opened_file>The user opened the file /some/file.md in the IDE.</ide_opened_file>' },
              { type: 'text', text: 'why does the redirect link need the full url?' },
            ],
          },
        },
      ];
      await fs.writeFile(path.join(projectFolder, 'sess.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions[0].title, 'why does the redirect link need the full url?');
    });
  });

  test('lastActivity tracks the last real user/assistant turn, not mere file mtime', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });
      const filePath = path.join(projectFolder, 'sess.jsonl');

      const oldTimestamp = '2020-01-01T00:00:00.000Z';
      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          type: 'user',
          isMeta: false,
          cwd: workspaceRoot,
          timestamp: oldTimestamp,
          message: { role: 'user', content: 'an old message' },
        })}\n`,
        'utf8',
      );

      const before = await listSessions(projectFolder);
      assert.strictEqual(before[0].lastActivity, Date.parse(oldTimestamp));

      // Simulate what merely opening a session does: Claude Code appends a housekeeping line
      // (no timestamp field, not a real turn) that bumps the file's mtime without adding activity.
      await fs.appendFile(filePath, `\n${JSON.stringify({ type: 'mode', mode: 'normal' })}\n`, 'utf8');

      const after = await listSessions(projectFolder);
      assert.strictEqual(
        after[0].lastActivity,
        Date.parse(oldTimestamp),
        'lastActivity must not reset just because the file was touched without a real turn',
      );
    });
  });

  test('renameSession appends a custom-title line that wins on the next parse', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions, renameSession } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });
      const filePath = path.join(projectFolder, 'sess.jsonl');

      await fs.writeFile(
        filePath,
        `${JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, message: { role: 'user', content: 'original' } })}\n`,
        'utf8',
      );

      const before = await listSessions(projectFolder);
      assert.strictEqual(before[0].title, 'original');

      await renameSession(filePath, 'sess', 'My renamed chat');

      const after = await listSessions(projectFolder);
      assert.strictEqual(after[0].title, 'My renamed chat');
    });
  });

  test('forkSession copies the transcript to a new sessionId and rewrites every occurrence', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions, forkSession } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(projectFolder, { recursive: true });
      const oldSessionId = 'old-session-id';
      const filePath = path.join(projectFolder, `${oldSessionId}.jsonl`);

      const lines = [
        { type: 'user', isMeta: false, cwd: workspaceRoot, sessionId: oldSessionId, message: { role: 'user', content: 'hi' } },
        { type: 'assistant', sessionId: oldSessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ];
      await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const { newSessionId, newFilePath } = await forkSession(filePath, oldSessionId);

      assert.notStrictEqual(newSessionId, oldSessionId);
      assert.strictEqual(path.basename(newFilePath), `${newSessionId}.jsonl`);

      const forkedContent = await fs.readFile(newFilePath, 'utf8');
      assert.ok(!forkedContent.includes(oldSessionId), 'no trace of the old sessionId should remain');
      assert.ok(forkedContent.includes(newSessionId));

      // The original must be untouched.
      const originalContent = await fs.readFile(filePath, 'utf8');
      assert.ok(originalContent.includes(oldSessionId));

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions.length, 2);
      const forked = sessions.find((s) => s.sessionId === newSessionId);
      assert.strictEqual(forked?.firstPrompt, 'hi');
    });
  });

  test('listSessions detects a subagents subfolder', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { listSessions } = await import('../../src/sessionStore');
      const projectFolder = path.join(claudeHome, 'projects', 'p');
      await fs.mkdir(path.join(projectFolder, 'sess', 'subagents'), { recursive: true });
      await fs.writeFile(
        path.join(projectFolder, 'sess.jsonl'),
        `${JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, message: { role: 'user', content: 'hi' } })}\n`,
        'utf8',
      );

      const sessions = await listSessions(projectFolder);
      assert.strictEqual(sessions[0].hasSubagents, true);
    });
  });
});
