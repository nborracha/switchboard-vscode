import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function withFakeHome(fn: (fakeHome: string) => Promise<void>): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-hidden-'));
  const fakeHome = path.join(tmpRoot, 'fake-home');
  await fs.mkdir(fakeHome, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await fn(fakeHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

// The lookup path is macOS-specific by design (this is a personal tool for one machine) — skip
// gracefully elsewhere rather than failing on an untested platform.
suite('hiddenSessions', function () {
  suiteSetup(function () {
    if (process.platform !== 'darwin') {
      this.skip();
    }
  });

  test('returns an empty set when the state db does not exist', async () => {
    await withFakeHome(async () => {
      const { readHiddenSessionIds } = await import('../../src/hiddenSessions');
      const ids = await readHiddenSessionIds();
      assert.strictEqual(ids.size, 0);
    });
  });

  test('reads hiddenSessionIds from the shared VS Code global-state db', async () => {
    await withFakeHome(async (fakeHome) => {
      const dbDir = path.join(fakeHome, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
      await fs.mkdir(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'state.vscdb');

      const value = JSON.stringify({ hiddenSessionIds: ['a', 'b', 'c'] }).replace(/'/g, "''");
      const sql =
        'CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);' +
        `INSERT INTO ItemTable (key, value) VALUES ('Anthropic.claude-code', '${value}');`;
      await execFileAsync('sqlite3', [dbPath, sql]);

      const { readHiddenSessionIds } = await import('../../src/hiddenSessions');
      const ids = await readHiddenSessionIds();
      assert.deepStrictEqual([...ids].sort(), ['a', 'b', 'c']);
    });
  });
});
