import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseLiveSessionEntry, liveSessionIds } from '../../src/liveSessions';

suite('liveSessions', () => {
  test('parseLiveSessionEntry accepts the CLI registry shape and rejects anything else', () => {
    assert.deepStrictEqual(parseLiveSessionEntry('{"pid":123,"sessionId":"s1","cwd":"/r","startedAt":1,"kind":"interactive"}'), {
      pid: 123,
      sessionId: 's1',
      cwd: '/r',
    });
    assert.strictEqual(parseLiveSessionEntry('{"pid":"123","sessionId":"s1"}'), undefined);
    assert.strictEqual(parseLiveSessionEntry('not json'), undefined);
  });

  test('liveSessionIds keeps entries whose pid is alive and drops stale registry files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-live-'));
    try {
      await fs.writeFile(path.join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'alive' }), 'utf8');
      await fs.writeFile(path.join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'dead' }), 'utf8');
      await fs.writeFile(path.join(dir, '3.json'), 'garbage', 'utf8');
      await fs.writeFile(path.join(dir, '1.abc.key'), 'ignored', 'utf8');

      const live = await liveSessionIds(dir, (pid) => pid === 1);
      assert.deepStrictEqual([...live], ['alive']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('liveSessionIds is empty when the registry dir does not exist', async () => {
    assert.strictEqual((await liveSessionIds(path.join(os.tmpdir(), 'switchboard-no-such-dir-xyz'))).size, 0);
  });
});
