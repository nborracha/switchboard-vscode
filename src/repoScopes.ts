import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// git reports worktree paths through their *resolved* form (e.g. macOS's /tmp -> /private/tmp),
// which can differ syntactically from the raw path a caller passed in even when it's the exact
// same location on disk. Comparing raw strings alone would then miss a real duplicate — e.g. the
// main repo's own entry in its OWN `git worktree list` output, added a second time under its
// resolved spelling. Used only to decide "is this a location already added", never as the stored
// scope root: resolveProjectFolder() matches session cwds by their original, un-resolved text, so
// scopes must keep whatever path form the caller (VS Code, or git for a genuinely new worktree)
// handed us.
async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await fsp.realpath(candidate);
  } catch {
    return candidate;
  }
}

export interface WorkspaceFolderInput {
  root: string;
  name: string;
}

export interface RepoScope {
  /** Absolute path Switchboard should resolve a Claude Code project folder for. */
  root: string;
  /** Human label for the UI — the workspace folder's own name, or "<folder> (<branch>)" for a worktree. */
  label: string;
}

interface WorktreeEntry {
  worktreePath: string;
  branch?: string;
  /** git's own verdict that the worktree's directory is gone (`prunable <reason>` line). */
  prunable?: boolean;
}

/**
 * Parses `git worktree list --porcelain` output into path/branch pairs. Pure — no subprocess —
 * so the format assumption is unit-testable against a fixture string, not just live git output.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const results: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) {
        results.push(current);
      }
      current = { worktreePath: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('prunable') && current) {
      current.prunable = true;
    }
  }
  if (current) {
    results.push(current);
  }
  return results;
}

async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: root });
    // A worktree whose directory was deleted by hand stays listed until `git worktree prune`; there
    // is nothing on disk to scope, and resolving it would only cost a pointless project-folder search.
    return parseWorktreeListPorcelain(stdout).filter((entry) => !entry.prunable);
  } catch {
    // Not a git repo, git unavailable, or genuinely no worktrees — same outcome either way: just
    // this one folder, no additional scopes. Never a hard dependency.
    return [];
  }
}

/**
 * Expands every open VS Code workspace folder into itself plus any git worktrees associated with
 * it. A single Claude Code session can span both: when an agent `cd`s into a worktree mid-
 * conversation, Claude Code stores the whole transcript under the worktree's own project folder —
 * invisible if only the main folder is ever scanned. Also covers genuinely separate repos already
 * open in the same VS Code window (a multi-root workspace), which previously were never scanned
 * at all (only `workspaceFolders[0]` was).
 *
 * Deduplicated by resolved root path, so a worktree that's *also* separately open as its own
 * top-level workspace folder is only scanned once.
 */
export async function discoverScopes(folders: WorkspaceFolderInput[]): Promise<RepoScope[]> {
  const seenReal = new Set<string>();
  const scopes: RepoScope[] = [];

  const addScope = async (root: string, label: string): Promise<void> => {
    const real = await realpathOrSelf(root);
    if (seenReal.has(real)) {
      return;
    }
    seenReal.add(real);
    scopes.push({ root, label });
  };

  for (const folder of folders) {
    await addScope(folder.root, folder.name);
  }

  const perFolderWorktrees = await Promise.all(folders.map((folder) => listWorktrees(folder.root)));
  for (let i = 0; i < folders.length; i += 1) {
    const folder = folders[i];
    for (const { worktreePath, branch } of perFolderWorktrees[i]) {
      const label = `${folder.name} (${branch || path.basename(worktreePath)})`;
      await addScope(worktreePath, label);
    }
  }

  return scopes;
}
