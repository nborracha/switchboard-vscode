import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-meta-'));
  process.env.CLAUDE_CHAT_MANAGER_HOME = tmpRoot;
  try {
    await fn();
  } finally {
    delete process.env.CLAUDE_CHAT_MANAGER_HOME;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

suite('MetadataStore', () => {
  test('persists pin/tag state and reloads it from a fresh instance', async () => {
    await withTempHome(async () => {
      const { MetadataStore } = await import('../../src/metadataStore');
      const store = new MetadataStore('workspace-a');
      await store.setPinned('s1', true);
      await store.setTags('s1', ['bug', 'urgent']);

      const reloaded = new MetadataStore('workspace-a');
      const all = await reloaded.getAll();
      assert.strictEqual(all.s1.pinned, true);
      assert.deepStrictEqual(all.s1.tags, ['bug', 'urgent']);
    });
  });

  test('removeSession deletes only the targeted session entry', async () => {
    await withTempHome(async () => {
      const { MetadataStore } = await import('../../src/metadataStore');
      const store = new MetadataStore('workspace-b');
      await store.setPinned('s1', true);
      await store.setPinned('s2', true);
      await store.removeSession('s1');

      const all = await store.getAll();
      assert.strictEqual(all.s1, undefined);
      assert.strictEqual(all.s2.pinned, true);
    });
  });

  test('setArchived persists independently of pinned/tags', async () => {
    await withTempHome(async () => {
      const { MetadataStore } = await import('../../src/metadataStore');
      const store = new MetadataStore('workspace-c');
      await store.setTags('s1', ['bug']);
      await store.setArchived('s1', true);

      const all = await store.getAll();
      assert.strictEqual(all.s1.archived, true);
      assert.deepStrictEqual(all.s1.tags, ['bug']);
    });
  });

  test('getAllTags aggregates distinct tags across every session, sorted', async () => {
    await withTempHome(async () => {
      const { MetadataStore } = await import('../../src/metadataStore');
      const store = new MetadataStore('workspace-d');
      await store.setTags('s1', ['urgent', 'bug']);
      await store.setTags('s2', ['bug', 'frontend']);

      const tags = await store.getAllTags();
      assert.deepStrictEqual(tags, ['bug', 'frontend', 'urgent']);
    });
  });
});
