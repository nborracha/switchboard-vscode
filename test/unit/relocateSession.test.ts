import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function withFixture(fn: (opts: { claudeHome: string; workspaceRoot: string }) => Promise<void>): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-relocate-'));
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

suite('relocateSession', () => {
  test('moves the transcript and its sidecar dir, stamps relocated + null worktree-state, and every reader re-homes it', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { relocateSession, listSessions } = await import('../../src/sessionStore');
      const worktreeRoot = path.join(workspaceRoot, '.worktrees', 'PLAT-1');
      const worktreeFolder = path.join(claudeHome, 'projects', 'wt');
      const mainFolder = path.join(claudeHome, 'projects', 'main');
      const sessionId = 'a1b2c3d4-0000-4000-8000-000000000001';
      await fs.mkdir(path.join(worktreeFolder, sessionId, 'subagents'), { recursive: true });
      const src = path.join(worktreeFolder, `${sessionId}.jsonl`);
      const lines = [
        { type: 'user', isMeta: false, cwd: workspaceRoot, sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'relocated', sessionId, relocatedCwd: worktreeRoot },
        { type: 'worktree-state', worktreeSession: { worktreePath: worktreeRoot, enteredExisting: true }, sessionId },
      ];
      await fs.writeFile(src, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const result = await relocateSession(src, sessionId, mainFolder, workspaceRoot, 1234);

      assert.strictEqual(result.newFilePath, path.join(mainFolder, `${sessionId}.jsonl`));
      assert.strictEqual(result.setAside, undefined);
      assert.strictEqual(result.sidecarMoved, true);
      await assert.rejects(fs.access(src), 'source transcript must be gone (renamed, not copied)');
      await fs.access(path.join(mainFolder, sessionId, 'subagents'));

      const moved = (await fs.readFile(result.newFilePath, 'utf8')).split('\n').filter((l) => l.trim());
      const last = JSON.parse(moved[moved.length - 1]);
      const secondLast = JSON.parse(moved[moved.length - 2]);
      assert.deepStrictEqual(secondLast, { type: 'relocated', sessionId, relocatedCwd: workspaceRoot });
      assert.deepStrictEqual(last, { type: 'worktree-state', worktreeSession: null, sessionId });

      assert.strictEqual((await listSessions(worktreeFolder)).length, 0);
      const inMain = await listSessions(mainFolder);
      assert.strictEqual(inMain.length, 1);
      assert.strictEqual(inMain[0].sessionId, sessionId);
      assert.strictEqual(inMain[0].firstPrompt, 'hi', 'history is intact after the move');
    });
  });

  test('sets aside an existing destination as .superseded-<ts> instead of overwriting it', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { relocateSession, supersededPath } = await import('../../src/sessionStore');
      const worktreeFolder = path.join(claudeHome, 'projects', 'wt');
      const mainFolder = path.join(claudeHome, 'projects', 'main');
      const sessionId = 'a1b2c3d4-0000-4000-8000-000000000002';
      await fs.mkdir(worktreeFolder, { recursive: true });
      await fs.mkdir(mainFolder, { recursive: true });
      const src = path.join(worktreeFolder, `${sessionId}.jsonl`);
      const dest = path.join(mainFolder, `${sessionId}.jsonl`);
      await fs.writeFile(src, JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, sessionId, message: { role: 'user', content: 'new' } }), 'utf8');
      await fs.writeFile(dest, JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, sessionId, message: { role: 'user', content: 'stale copy' } }), 'utf8');

      const result = await relocateSession(src, sessionId, mainFolder, workspaceRoot, 777);

      assert.strictEqual(result.setAside, supersededPath(dest, 777));
      assert.strictEqual(await fs.readFile(result.setAside!, 'utf8'), JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, sessionId, message: { role: 'user', content: 'stale copy' } }));
      assert.ok((await fs.readFile(dest, 'utf8')).includes('"new"'), 'the moved transcript is the one at the destination');
    });
  });

  test('sets aside a colliding destination sidecar dir as well, and the moved transcript is stamped even so', async () => {
    await withFixture(async ({ claudeHome, workspaceRoot }) => {
      const { relocateSession, supersededPath } = await import('../../src/sessionStore');
      const worktreeFolder = path.join(claudeHome, 'projects', 'wt');
      const mainFolder = path.join(claudeHome, 'projects', 'main');
      const sessionId = 'a1b2c3d4-0000-4000-8000-000000000003';
      // The session's current sidecar (in the worktree folder) and a non-empty leftover sidecar at
      // the destination from an earlier stay there — a plain rename onto it fails with ENOTEMPTY.
      await fs.mkdir(path.join(worktreeFolder, sessionId, 'subagents'), { recursive: true });
      await fs.writeFile(path.join(worktreeFolder, sessionId, 'subagents', 'agent-new.jsonl'), '{}', 'utf8');
      await fs.mkdir(path.join(mainFolder, sessionId, 'subagents'), { recursive: true });
      await fs.writeFile(path.join(mainFolder, sessionId, 'subagents', 'agent-old.jsonl'), '{}', 'utf8');
      const src = path.join(worktreeFolder, `${sessionId}.jsonl`);
      await fs.writeFile(src, JSON.stringify({ type: 'user', isMeta: false, cwd: workspaceRoot, sessionId, message: { role: 'user', content: 'hi' } }), 'utf8');

      const result = await relocateSession(src, sessionId, mainFolder, workspaceRoot, 555);

      const destSidecar = path.join(mainFolder, sessionId);
      assert.strictEqual(result.sidecarMoved, true);
      assert.strictEqual(result.sidecarSetAside, supersededPath(destSidecar, 555));
      await fs.access(path.join(result.sidecarSetAside!, 'subagents', 'agent-old.jsonl'));
      await fs.access(path.join(destSidecar, 'subagents', 'agent-new.jsonl'));
      await assert.rejects(fs.access(path.join(destSidecar, 'subagents', 'agent-old.jsonl')), 'the leftover must not be merged into the moved sidecar');

      const moved = (await fs.readFile(result.newFilePath, 'utf8')).split('\n').filter((l) => l.trim());
      assert.deepStrictEqual(JSON.parse(moved[moved.length - 1]), { type: 'worktree-state', worktreeSession: null, sessionId });
      assert.deepStrictEqual(JSON.parse(moved[moved.length - 2]), { type: 'relocated', sessionId, relocatedCwd: workspaceRoot });
    });
  });
});
