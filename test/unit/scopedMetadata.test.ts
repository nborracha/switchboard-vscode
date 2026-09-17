import * as assert from 'node:assert';
import type { SessionMetadata } from '../../src/metadataStore';

type PerScope = Map<string, Record<string, SessionMetadata>>;

suite('pickScopedMetadata', () => {
  const MAIN = '/repo/management';
  const WORKTREE = '/repo/management/.worktrees/PLAT-1';
  const SESSION = 'bd92376f-b9a9-4168-8ae4-2122f4746c3b';

  test('the scope the session lives in now wins over a stale entry left in its previous scope', async () => {
    const { pickScopedMetadata } = await import('../../src/metadataStore');

    // Exactly the real failure: the chat was archived while it lived in the worktree, then moved
    // into the main workspace and pinned there. The worktree store is iterated last, so a flat
    // merge returned the stale archived/unpinned entry and the pin looked like it did nothing.
    const perScope: PerScope = new Map<string, Record<string, SessionMetadata>>([
      [MAIN, { [SESSION]: { pinned: true, archived: false } }],
      [WORKTREE, { [SESSION]: { pinned: false, archived: true } }],
    ]);

    assert.deepStrictEqual(pickScopedMetadata(perScope, SESSION, MAIN), { pinned: true, archived: false });
    assert.deepStrictEqual(pickScopedMetadata(perScope, SESSION, WORKTREE), { pinned: false, archived: true });
  });

  test('another scope\'s entry still applies when the owning scope has none, so a pin survives a move', async () => {
    const { pickScopedMetadata } = await import('../../src/metadataStore');

    const perScope: PerScope = new Map<string, Record<string, SessionMetadata>>([
      [MAIN, {}],
      [WORKTREE, { [SESSION]: { pinned: true, tags: ['review'] } }],
    ]);

    assert.deepStrictEqual(pickScopedMetadata(perScope, SESSION, MAIN), { pinned: true, tags: ['review'] });
  });

  test('a session no scope has metadata for resolves to an empty entry', async () => {
    const { pickScopedMetadata } = await import('../../src/metadataStore');

    const perScope: PerScope = new Map<string, Record<string, SessionMetadata>>([[MAIN, { other: { pinned: true } }]]);

    assert.deepStrictEqual(pickScopedMetadata(perScope, SESSION, MAIN), {});
    assert.deepStrictEqual(pickScopedMetadata(new Map<string, Record<string, SessionMetadata>>(), SESSION, MAIN), {});
  });
});
