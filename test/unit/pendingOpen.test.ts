import * as assert from 'node:assert';
import { matchesPendingOpen, isPendingOpen, PENDING_OPEN_TTL_MS } from '../../src/pendingOpen';

suite('pendingOpen', () => {
  const pending = { sessionId: 'abc', repoRoot: '/repo/.worktrees/PLAT-1', requestedAt: 1_000_000 };

  test('matches a fresh request whose canonical root equals this window\'s primary root', () => {
    assert.strictEqual(matchesPendingOpen(pending, '/real/repo/.worktrees/PLAT-1', '/real/repo/.worktrees/PLAT-1', pending.requestedAt + 5_000), true);
  });

  test('ignores a request for a different root', () => {
    assert.strictEqual(matchesPendingOpen(pending, '/real/repo', '/real/repo/.worktrees/PLAT-1', pending.requestedAt + 5_000), false);
  });

  test('ignores a stale request past the ttl', () => {
    assert.strictEqual(
      matchesPendingOpen(pending, '/r', '/r', pending.requestedAt + PENDING_OPEN_TTL_MS + 1),
      false,
      'a window opened for an unrelated reason minutes later must not open an old chat',
    );
  });

  test('ignores a request from the future (clock skew) and malformed values', () => {
    assert.strictEqual(matchesPendingOpen(pending, '/r', '/r', pending.requestedAt - 1), false);
    assert.strictEqual(matchesPendingOpen(undefined, '/r', '/r', 0), false);
    assert.strictEqual(matchesPendingOpen({ sessionId: 'x' }, '/r', '/r', 0), false);
    assert.strictEqual(isPendingOpen({ sessionId: 'x', repoRoot: '/r', requestedAt: 'no' }), false);
  });
});
