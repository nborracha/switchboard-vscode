# Switchboard — agent config

Standalone local VS Code extension, not part of the `management` monorepo. See `PLAN.md` for the design and phase breakdown.

## No workarounds — fix the root cause

Default: implement the proper fix. A workaround is a change whose primary effect is to make a symptom
disappear without removing its cause. If you cannot state the root cause in one sentence, you don't have
a fix — you have a band-aid. This applies to: suppressing a lint/type check, swallowing an error, hard-coding
what should be derived, mocking around a missing piece, patching at the wrong layer, or leaving
`TODO`/`FIXME`/`HACK` in committed code. Stop and ask only when a proper fix is genuinely blocked
(architectural change, missing access) — then state the root cause, the block, at least two options, and
a recommendation before proceeding.

## Definition of done (scaled down from `management`)

This project has none of `management`'s repo-specific machinery (no `pnpm verify`, no ticket-scoped plan
gate, no `pid` plugin hooks) — so the substance of its DoD is carried over as real, runnable local gates
instead:

1. **Machine gate** — all of these must pass before calling anything done:
   - `npm run typecheck` (`tsc --noEmit`, strict mode)
   - `npm run lint` (ESLint, flat config in `eslint.config.mjs`)
   - `npm run build` (esbuild bundle to `dist/extension.js`)
2. **Self-review** — read the full diff critically before declaring a phase complete: correctness, unhandled
   edge cases, anything touching Anthropic's own `~/.claude` files that isn't strictly additive/read-only
   where it should be.
3. Never run destructive experiments (real deletion, cleanup-sweep testing) against the user's real
   `~/.claude` data — always against fixtures or a sandboxed `CLAUDE_CONFIG_DIR`.

## Code style

- No comments unless the *why* is non-obvious (a workaround, a hidden constraint, a surprising invariant).
  Never explain *what* the code does.
- No `continue` in loops — use nested `if` (enforced by `no-continue` in `eslint.config.mjs`, matching
  `management`'s convention).
- Minimal abstraction — don't build for hypothetical future requirements.
- This extension only reads Anthropic's own `~/.claude` files, or writes to files it created itself
  (`~/.claude-chat-manager/**`). The one deliberate exception is the explicit, user-confirmed
  "delete session" command, whose entire purpose is real removal of an Anthropic-owned transcript
  (the official extension's own "delete" only soft-hides it) — that's a disclosed feature, not a
  workaround. Outside of that one confirmed action, never modify an existing Anthropic-owned file
  in place.
