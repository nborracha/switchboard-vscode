<img src="resources/icon.png" width="96" align="right" alt="Switchboard">

# Switchboard

**Session and agent manager for Claude Code.** Pin, tag, archive, fork, rename and search your Claude Code chats — and watch background agents — from one sidebar in VS Code.

> **Unofficial.** Switchboard is an independent companion extension. It is not affiliated with, endorsed by, or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

---

## What it's for

Claude Code's own sessions list covers titles, keyword search, browse-by-time and named groups. Switchboard is a layer *beside* that, not a replacement for it — it does the things the official list doesn't:

| | Switchboard | Official sessions list |
|---|---|---|
| Organize | **Multi-membership tags** + pin + archive | Groups (one group per session) |
| Search | Titles, first prompt, tags — **plus full transcript-body grep** | Keyword over the list |
| Delete | **Removes the transcript file** | Hides the session (`hiddenSessionIds`) |
| Fork | **From any point**, by copying the transcript | Rewind menu, anchored to *your* messages |
| Agents | **`claude --bg` dispatch, attach, stop** | — |
| Live state | **Working / ready-for-review indicators** | — |

Switchboard never renders its own chat UI. Opening a session hands off to the official extension's own panel, so you keep the real Claude Code experience.

## Requirements

- VS Code 1.90 or later
- The official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) (Switchboard delegates to it, and falls back to `claude --resume` in a terminal if it's unavailable)
- The `claude` CLI on `PATH` for background agents

## Install

Not published to the Marketplace. Install the latest release with one command:

```bash
curl -fsSL -o /tmp/switchboard.vsix \
  https://github.com/nborracha/switchboard-vscode/releases/latest/download/switchboard.vsix \
  && code --install-extension /tmp/switchboard.vsix --force
```

`--force` lets the same command upgrade an existing install. Every release also carries a
version-stamped `switchboard-vX.Y.Z.vsix`, listed on the
[releases page](https://github.com/nborracha/switchboard-vscode/releases).

Or build it yourself:

```bash
pnpm install
pnpm run package
code --install-extension switchboard-0.1.0.vsix
```

Then reload the window. Switchboard appears in the Activity Bar.

Next, set up the tab layout: **[Recommended VS Code layout](docs/recommended-layout.md)**. Two minutes, and chats stop landing on top of your code.

## Commands

All commands are prefixed `Switchboard:` in the Command Palette. Row-level actions (open, pin, archive, tag, rename, fork, delete, attach/stop agent) are hidden from the palette and reachable from the sidebar rows.

| Command | Action |
|---|---|
| `switchboard.newSession` | New chat, or a new `claude --bg` background agent |
| `switchboard.search` | Focus the inline filter (title / first prompt / tags) |
| `switchboard.searchContent` | Grep full transcript bodies |
| `switchboard.refresh` | Re-scan sessions |

## Where your data lives

- **Read-only**, from Claude Code's own files: `~/.claude/**` transcripts.
- **Written by Switchboard**: `~/.claude-chat-manager/<workspace-identity>/metadata.json` — pins, tags, archive and hidden state. Override the root with `CLAUDE_CHAT_MANAGER_HOME`.

That directory keeps its original name so existing metadata isn't orphaned by the rename to Switchboard.

The one command that modifies Anthropic-owned files is **Delete Session**, which is explicit, confirmed, and exists precisely because the official delete only hides. Nothing else writes outside Switchboard's own sidecar.

## Known limitations

Stated plainly, because they are structural rather than to-do items:

- **The working / ready-for-review signal is a heuristic.** It infers activity from gaps in transcript writes (60s idle threshold). The CLI writes nothing while blocked on a long tool call, so a multi-minute build or test run can still read as "ready for review." No file-based signal can distinguish the two — the information isn't on disk.
- **Switchboard rides undocumented internals** of the official extension (its `claude-vscode.editor.open` command signature) and of Claude Code's on-disk transcript format. Both can change in any release. Every integration point has a terminal-based fallback, but behavior can still shift under you.
- **Chats open in the all-Claude tab group.** Switchboard passes no target column, so the official extension routes new panels itself and groups chats together. That is deliberate, but it needs a one-time layout setup to keep files out of that group — see [Recommended VS Code layout](docs/recommended-layout.md).

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint
npm run build       # esbuild -> dist/extension.js
npm run test:unit   # mocha
npm run test:e2e    # @vscode/test-electron (downloads a VS Code build)
```

## License

MIT — see [LICENSE](LICENSE).
