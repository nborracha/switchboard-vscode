import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

suite('repoScopes', () => {
  test('parseWorktreeListPorcelain reads paths and branches, including a detached (branch-less) entry', async () => {
    const { parseWorktreeListPorcelain } = await import('../../src/repoScopes');

    const porcelain = [
      'worktree /Users/nimrod/Projects/PlainID/management',
      'HEAD abc123',
      'branch refs/heads/master',
      '',
      'worktree /Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-28056',
      'HEAD def456',
      'branch refs/heads/PLAT-28056-general-domain-canvas',
      '',
      'worktree /Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-29537',
      'HEAD 789ghi',
      'detached',
      '',
      'worktree /Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-GONE',
      'HEAD 000aaa',
      'branch refs/heads/PLAT-GONE',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const entries = parseWorktreeListPorcelain(porcelain);
    assert.strictEqual(entries.length, 4);
    assert.strictEqual(entries[0].prunable, undefined);
    assert.strictEqual(entries[3].worktreePath, '/Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-GONE');
    assert.strictEqual(entries[3].prunable, true, 'a worktree whose directory is gone is flagged, not dropped, by the parser');
    assert.strictEqual(entries[0].worktreePath, '/Users/nimrod/Projects/PlainID/management');
    assert.strictEqual(entries[0].branch, 'master');
    assert.strictEqual(entries[1].worktreePath, '/Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-28056');
    assert.strictEqual(entries[1].branch, 'PLAT-28056-general-domain-canvas');
    assert.strictEqual(entries[2].worktreePath, '/Users/nimrod/Projects/PlainID/management/.worktrees/PLAT-29537');
    assert.strictEqual(entries[2].branch, undefined, 'a detached worktree has no branch line at all');
  });

  test('discoverScopes finds a real git worktree next to its main repo and labels it by branch', async () => {
    const { discoverScopes } = await import('../../src/repoScopes');

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-repo-scopes-'));
    const mainRepo = path.join(tmpRoot, 'main');
    const worktreePath = path.join(tmpRoot, 'worktree-plat');
    await fs.mkdir(mainRepo, { recursive: true });

    try {
      const git = (args: string[]) => execFileAsync('git', args, { cwd: mainRepo });
      await git(['init', '--quiet']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(mainRepo, 'file.txt'), 'hello', 'utf8');
      await git(['add', '.']);
      await git(['commit', '--quiet', '-m', 'initial']);
      await git(['worktree', 'add', '-b', 'PLAT-28056-general-domain-canvas', worktreePath]);

      const scopes = await discoverScopes([{ root: mainRepo, name: 'management' }]);

      assert.strictEqual(scopes.length, 2, 'expected the main repo plus its one worktree');
      assert.deepStrictEqual(scopes[0], { root: mainRepo, label: 'management' });
      // git reports worktree paths through their resolved form (macOS symlinks /tmp -> /private/tmp),
      // which can differ syntactically from the raw tmpdir() path used to create it above.
      const worktreePathReal = await fs.realpath(worktreePath);
      const worktreeScope = scopes.find((s) => s.root === worktreePathReal);
      assert.ok(worktreeScope, 'the worktree path should appear as its own scope');
      assert.strictEqual(worktreeScope!.label, 'management (PLAT-28056-general-domain-canvas)');
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('discoverScopes dedupes a worktree that is also separately listed as its own workspace folder', async () => {
    const { discoverScopes } = await import('../../src/repoScopes');

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-repo-scopes-dedup-'));
    const mainRepo = path.join(tmpRoot, 'main');
    const worktreePath = path.join(tmpRoot, 'worktree-plat');
    await fs.mkdir(mainRepo, { recursive: true });

    try {
      const git = (args: string[]) => execFileAsync('git', args, { cwd: mainRepo });
      await git(['init', '--quiet']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(mainRepo, 'file.txt'), 'hello', 'utf8');
      await git(['add', '.']);
      await git(['commit', '--quiet', '-m', 'initial']);
      await git(['worktree', 'add', '-b', 'PLAT-1', worktreePath]);

      // The worktree is ALSO passed in directly, as if the user added it as its own workspace
      // folder in the same VS Code window — it must not be scanned/scoped twice.
      const scopes = await discoverScopes([
        { root: mainRepo, name: 'management' },
        { root: worktreePath, name: 'management (worktree)' },
      ]);

      // Exactly two scopes: main + the worktree. Git also reports both under their *resolved*
      // spelling (macOS /tmp -> /private/tmp), and neither may sneak in as a third or fourth entry.
      assert.strictEqual(scopes.length, 2, `expected main + worktree only, got ${JSON.stringify(scopes)}`);
      assert.deepStrictEqual(
        scopes.map((s) => s.root),
        [mainRepo, worktreePath],
        'the caller\'s own path spelling is kept; the resolved duplicates from git are dropped',
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('discoverScopes skips a worktree whose directory was deleted by hand (git lists it as prunable)', async () => {
    const { discoverScopes } = await import('../../src/repoScopes');

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-repo-scopes-prunable-'));
    const mainRepo = path.join(tmpRoot, 'main');
    const worktreePath = path.join(tmpRoot, 'worktree-gone');
    await fs.mkdir(mainRepo, { recursive: true });

    try {
      const git = (args: string[]) => execFileAsync('git', args, { cwd: mainRepo });
      await git(['init', '--quiet']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(mainRepo, 'file.txt'), 'hello', 'utf8');
      await git(['add', '.']);
      await git(['commit', '--quiet', '-m', 'initial']);
      await git(['worktree', 'add', '-b', 'PLAT-GONE', worktreePath]);
      await fs.rm(worktreePath, { recursive: true, force: true });

      const scopes = await discoverScopes([{ root: mainRepo, name: 'management' }]);

      assert.deepStrictEqual(scopes, [{ root: mainRepo, label: 'management' }]);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('discoverScopes returns just the folder itself when it is not a git repo at all', async () => {
    const { discoverScopes } = await import('../../src/repoScopes');

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-repo-scopes-nongit-'));
    try {
      const scopes = await discoverScopes([{ root: tmpRoot, name: 'not-a-repo' }]);
      assert.deepStrictEqual(scopes, [{ root: tmpRoot, label: 'not-a-repo' }]);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
