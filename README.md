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
| Repos | **Every open workspace folder and its git worktrees, in one list** | The window's folder only |

Switchboard never renders its own chat UI. Opening a session hands off to the official extension's own panel, so you keep the real Claude Code experience.

## Requirements

- VS Code 1.90 or later
- The official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) (Switchboard delegates to it, and falls back to `claude --resume` in a terminal if it's unavailable)
- The `claude` CLI on `PATH` for background agents and **Resume in Terminal**
- `git` on `PATH` for worktree detection (without it, each workspace folder is scanned as just that one folder)

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
code --install-extension switchboard-<version>.vsix   # the version in package.json, e.g. switchboard-0.2.0.vsix
```

Then reload the window. Switchboard appears in the Activity Bar.

Next, set up the tab layout: **[Recommended VS Code layout](docs/recommended-layout.md)**. Two minutes, and chats stop landing on top of your code.

## Commands

All commands are prefixed `Switchboard:` in the Command Palette. Row-level actions (open, pin, archive, tag, rename, fork, delete, resume in terminal, move into workspace, open in a worktree window, attach/stop agent) are hidden from the palette and reachable from the sidebar rows and their "…" menu.

| Command | Action |
|---|---|
| `switchboard.newSession` | New chat, or a new `claude --bg` background agent |
| `switchboard.search` | Focus the inline filter (title / first prompt / tags) |
| `switchboard.searchContent` | Grep full transcript bodies |
| `switchboard.refresh` | Re-scan sessions |

## Where your data lives

- **Read** from Claude Code's own files: `~/.claude/projects/**` transcripts, the live-session registry `~/.claude/sessions/`, and VS Code's global state DB for the official extension's hidden-session list. `git worktree list` supplies the worktree scopes.
- **Written by Switchboard**: `~/.claude-chat-manager/<workspace-identity>/metadata.json` — pins, tags and archive state, one file per repo or worktree scope. Override the root with `CLAUDE_CHAT_MANAGER_HOME`. That directory keeps its original name so existing metadata isn't orphaned by the rename to Switchboard.

Four row actions write to Anthropic-owned transcript files. Each runs only on an explicit click and uses the CLI's own on-disk forms, never an invented one:

| Action | What it writes |
|---|---|
| **Rename** | Appends a `custom-title` record — the same record the official extension writes on rename |
| **Fork** | Writes a *new* transcript beside the original, with a new session id; the original is untouched |
| **Move into "<workspace>"** | The CLI's own exit-worktree relocation: `rename` into the workspace's project folder (an existing file there is set aside as `.superseded-<ts>`, never overwritten), then a `relocated` stamp and a null `worktree-state` stamp. Refused while a running Claude Code process holds the session; confirmed first |
| **Delete** | Removes the transcript, its `<sessionId>/` sidecar folder and `~/.claude/file-history/<sessionId>/` — the official delete only hides |

Nothing writes to a transcript in place other than those appends, and nothing happens without a click.

## Known limitations

Stated plainly, because they are structural rather than to-do items:

- **The working / ready-for-review signal is a heuristic.** It infers activity from gaps in transcript writes (60s idle threshold). The CLI writes nothing while blocked on a long tool call, so a multi-minute build or test run can still read as "ready for review." No file-based signal can distinguish the two — the information isn't on disk.
- **Switchboard rides undocumented internals** of the official extension (its `claude-vscode.editor.open` command signature) and of Claude Code's on-disk transcript format. Both can change in any release. Every integration point has a terminal-based fallback, but behavior can still shift under you.
- **Chats open in the all-Claude tab group.** Switchboard passes no target column, so the official extension routes new panels itself and groups chats together. That is deliberate, but it needs a one-time layout setup to keep files out of that group — see [Recommended VS Code layout](docs/recommended-layout.md).
- **Repo scanning follows VS Code workspace folders and git worktrees, nothing further.** A repo you have not opened in this VS Code window (and that is not a worktree of one you have) never appears, even if Claude Code has sessions for it elsewhere on disk. Worktree detection itself depends on `git worktree list` succeeding — a repo with no `.git` reachable from its folder (or no `git` on PATH) is scanned as just that one folder. Worktrees added, and chat-history folders first created, after the window opened are picked up on the next refresh (automatic within about 30 seconds, immediate on **Refresh**).
- **A chat that entered a git worktree lives in that worktree's project folder.** Claude Code (CLI ≥ 2.1.198) moves the transcript when a session enters or exits a worktree and records a `relocated` marker in it; Switchboard lists such chats under the worktree's own scope (shown as a repo badge when more than one scope is visible). Opening one from the main repo's window is where it gets awkward: the official extension's panel checks a session against a list built from the *window's* project folder only (`includeWorktrees: false` as of 2.1.263), so in that window it declines and shows a brand-new empty chat. Switchboard therefore offers a chooser for such a chat: **Move into "<workspace>" and open here** (the same relocation Claude Code performs when a session exits a worktree — `rename` into this workspace's project folder plus the `relocated` and null `worktree-state` stamps — after which every reader, the official panel included, treats it as a normal chat of this workspace; refused while a running Claude Code process holds the session), **Open in a window at "<worktree>"** (a VS Code window rooted at the worktree — its panel finds the chat natively; Switchboard in that window opens it for you), **Resume in Terminal** (`claude --resume` from the chat's own folder, works everywhere), or **Open here anyway**. If the agent enters the worktree again later, Claude Code moves the chat back there and the chooser reappears. The same limitation bites the official panel's own **Fork / rewind** on such a chat: it stops the running turn first, then fails with "Session not found". Move the chat into the workspace before forking there, or use Switchboard's Fork — the copy gets the same chooser.

## Troubleshooting

Switchboard logs to the **Output** panel (channel "Switchboard") and VS Code persists that channel to disk, so it can be read after a reload — on macOS under `~/Library/Application Support/Code/logs/<session>/window*/exthost/nimrodk.switchboard/Switchboard.log`. Every open records which Claude Code panels existed before and after the hand-off and whether the official command resolved, which tells apart "created a panel", "revealed an already-open one" and "did nothing". The official extension's own channel ("Claude VSCode", same directory tree) shows what its panel did with the session.

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint
npm run build       # esbuild -> dist/extension.js
npm run test:unit   # mocha
npm run test:e2e    # @vscode/test-electron (downloads a VS Code build)
npm run package     # vsce -> switchboard-<version>.vsix
```

Releases: bump `version` in `package.json`, commit, tag `vX.Y.Z` and push the tag — the `Release` workflow builds the `.vsix`, attaches it as `switchboard-vX.Y.Z.vsix` plus a stable `switchboard.vsix`, and publishes the GitHub release.

## License

MIT — see [LICENSE](LICENSE).
