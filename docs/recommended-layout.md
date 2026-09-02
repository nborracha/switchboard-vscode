# Recommended VS Code layout

Two minutes of setup keeps chats and files out of each other's way: one tab group for code, one
locked group for Claude chats, and no leakage between them.

## 1. Add the settings

Press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, run **Preferences: Open User Settings (JSON)**,
and merge this in:

```jsonc
{
  "claudeCode.preferredLocation": "panel",
  "workbench.editor.autoLockGroups": {
    "mainThreadWebview-claudeVSCodePanel": true
  },
  "workbench.editor.revealIfOpen": true,
  "workbench.editor.enablePreview": false
}
```

`claudeCode.preferredLocation: "panel"` means "open Claude as an editor tab". The name is
misleading — it does not put Claude in the bottom panel.

`autoLockGroups` is the important one. `mainThreadWebview-claudeVSCodePanel` is the editor id of a
Claude chat tab, so this entry tells VS Code to lock any group whose first tab is a chat.

> `claudeCode.preferredLocation` and the `mainThreadWebview-claudeVSCodePanel` editor id both belong
> to the official Claude Code extension, and neither is documented. Either can change in any
> release. See [Known limitations](../README.md#known-limitations).

## 2. Build the layout once

1. Open a code file. It lands in the left group.
2. Open a chat from the Switchboard sidebar. It opens in a new group on the right.
3. Click that chat group. Run **View: Lock Editor Group** from the Command Palette, or use the
   group's `⋯` menu → **Lock Group**.

The lock is saved with the window layout, so it survives a restart.

### Why the lock is manual

`autoLockGroups` only fires when a chat is the first and only tab in a new group. It never locks a
group after the fact. This is why the setting alone appears to do nothing on a layout you already
have — step 3 covers that one existing group.

## 3. Open chats from the Switchboard sidebar

Do not use Claude Code's own **Session history** dialog. That dialog opens the chat in whichever
group has focus, so it drops chats on top of your code. Switchboard passes no target column, which
lets the official extension find and reuse the all-chat group.

## Optional: a permanent chat in the secondary sidebar

To keep one chat on screen at all times, drag the Claude panel tab into the secondary sidebar at the
right edge. Use that for your main session, and use the locked group for side tasks.

Opening a chat resets `claudeCode.preferredLocation` to `panel`. The official extension does this,
not Switchboard. It only affects where the next default Claude open goes; a session already in the
secondary sidebar stays there.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Files keep opening in the chat group | The group is not locked. Click it, then run **View: Lock Editor Group**. |
| A new chat opened in a third group | A file tab got into the chat group. Move the file out. The official extension reuses a group only when every tab in it is a chat, so one stray file disqualifies it. |
