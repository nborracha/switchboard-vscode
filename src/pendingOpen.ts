/**
 * A request to open a session in the VS Code window rooted at `repoRoot`, handed from one window
 * to another through the extension's `globalState` (shared across windows).
 */
export interface PendingOpen {
  sessionId: string;
  repoRoot: string;
  requestedAt: number;
}

export const PENDING_OPEN_KEY = 'switchboard.pendingOpen';

/**
 * A stale request must never fire — a window opened for an unrelated reason minutes later shouldn't
 * suddenly open an old chat. Two minutes comfortably covers a fresh window's startup plus a slow
 * extension-host activation.
 */
export const PENDING_OPEN_TTL_MS = 120_000;

export function isPendingOpen(value: unknown): value is PendingOpen {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string' && typeof v.repoRoot === 'string' && typeof v.requestedAt === 'number';
}

/**
 * Whether this window should act on a pending open: it must target this window's primary root
 * (both paths already canonicalized by the caller) and still be fresh. Pure, so the ttl/match
 * rules are unit-testable without VS Code.
 */
export function matchesPendingOpen(
  pending: unknown,
  primaryRootCanonical: string,
  pendingRootCanonical: string,
  now: number,
  ttlMs: number = PENDING_OPEN_TTL_MS,
): pending is PendingOpen {
  if (!isPendingOpen(pending)) {
    return false;
  }
  if (pendingRootCanonical !== primaryRootCanonical) {
    return false;
  }
  return now - pending.requestedAt >= 0 && now - pending.requestedAt <= ttlMs;
}
