# 🌳 pi-worktree — Safe Git Worktree and Jujutsu Workspace Management for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-worktree)](https://www.npmjs.com/package/@narumitw/pi-worktree) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-worktree` adds one interactive `/worktree` command for common Git worktree and Jujutsu workspace operations and Pi workspace switching.

Pi cannot change its parent process working directory with `cd`. This extension performs the safe equivalent: it prepares a Pi session whose cwd is the selected worktree or jj workspace and switches to that session, preserving the current conversation when it has already been persisted.

## ✨ Features

- One command for both VCS families: inside a Jujutsu repo (`jj`), `/worktree` manages jj workspaces; everywhere else it manages Git worktrees.
- Shows compact main, linked, current, detached, locked, and prunable state in worktree selectors.
- Creates a new branch worktree or attaches an existing unoccupied local branch.
- Rejects occupied targets and unresolvable symbolic-link ancestors before Git can create a branch.
- Suggests `~/.worktrees/<main-worktree-name>/<branch>` by default and lets the user configure the root interactively.
- Optionally switches Pi into a newly created worktree while continuing the current conversation.
- Switches among existing registered worktrees through Pi's public session replacement API.
- Removes unlocked, non-current linked worktrees and preserves their branches.
- Refuses removal when tracked, untracked, manually index-flagged, submodule, or current unreachable detached-commit data may be lost.
- Allows ignored-only data such as `node_modules/` after listing it in the destructive confirmation.
- Names recovery-only administrative commits in the destructive confirmation instead of making ordinary rebase/reset history block cleanup forever.
- Always previews stale metadata before pruning it and revalidates the preview after confirmation.
- Runs Git and jj through argv-based subprocess calls, without interpolating user input into shell commands.

### Jujutsu workspace support

- Detects jj workspaces by walking ancestors for `.jj`; colocated repositories are managed as jj workspaces because jj owns their workspace layout.
- Lists every workspace with its root path, change id, dirty/conflicted/abandoned working copy state, and current/main markers.
- Creates a workspace at a chosen path with an optional name and an optional start point (default: the parent of the current change, matching `jj workspace add`).
- Switches Pi among registered workspaces, refusing abandoned working copies and missing roots.
- Removes (forgets) only clean, non-current, non-main workspaces. `jj workspace forget` never deletes directories, so the directory is always retained on disk.
- Prunes stale workspaces: forgotten directories (jj can no longer resolve their root) and workspaces whose working copy commit was abandoned. Prune refuses when a stale workspace still holds uncommitted or conflicted changes, because forgetting would silently abandon them.
- Reads state through `jj workspace list --ignore-working-copy -T ...`, so listing never snapshots or mutates the current working copy.

## 📦 Install

```bash
pi install npm:@narumitw/pi-worktree
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-worktree
```

Try this package locally from the repository root:

```bash
just try worktree
# or: pi -e ./packages/pi-worktree
```

## 💬 Usage

Run the command without arguments:

```text
/worktree
```

`/workspace` is an alias for `/worktree`; both names open the same menu. The
command is VCS-aware: inside a Jujutsu repo it manages jj workspaces,
everywhere else it manages Git worktrees.

Choose one action (labels use *workspace* wording inside jj repositories):

- **Add worktree / workspace** — for Git: enter a branch, optional start point, and optional path; confirm creation and optionally switch. For jj: enter an optional workspace name, an optional start point, and a path.
- **Switch worktree / workspace** — select another existing worktree or workspace and continue this Pi conversation there.
- **Remove worktree / workspace** — Git: remove a linked worktree without deleting its branch; ignored-only data is listed for explicit confirmation. jj: forget a clean workspace; its directory is retained.
- **Prune stale metadata / workspaces** — Git: inspect `git worktree prune --dry-run --verbose`, then optionally prune. jj: preview stale workspaces (missing roots or abandoned working copies), then forget them together.
- **Configure worktree root** — set a machine-local default root or submit a blank value to restore `~/.worktrees`.

The standard root menu shows the registered count, current path, effective worktree root, its source,
and any settings warning. Escape closes it. `/worktree` intentionally does not accept text
subcommands or expose argument autocomplete. Every change is initiated and confirmed through TUI or
RPC dialogs; print and JSON modes reject the command observably. Operation-specific branch/path
inputs, worktree identity selectors, preflight previews, and destructive confirmations remain
extension-owned because they carry Git safety and commit-aware revalidation.

## 🌿 Add defaults

For a new branch, the current symbolic branch is the default start point. If Pi is running from detached HEAD, the command requires an explicit commit-ish. Git must resolve the start point to exactly one commit.

The default root is `~/.worktrees`, where `~` is Node's platform home directory. Suggestions use the registered main worktree's directory name, not the current linked-worktree cwd:

```text
main worktree: /home/user/workspace/project
branch:        feat/login
root:          /home/user/.worktrees
suggested:     /home/user/.worktrees/project/feat-login
```

On Windows, the equivalent default is such as `C:\Users\Alice\.worktrees`. Branch `/` characters become `-`. The extension does not add hashes or collision suffixes: if two normalized paths collide or the target already exists, Add stops before Git mutation.

Leave the path input blank to accept the suggestion. A custom absolute path is used directly; a custom relative path is resolved from the current Pi cwd. The target itself must not exist, and its nearest existing ancestor must resolve without a broken or looping symbolic link. Existing registered worktrees are never moved when this default changes.

The MVP does not expose `--force`, `-B`, `--detach`, `--orphan`, or lock options.

### Jujutsu add flow

In a jj repository the Add flow asks for an optional workspace name, an optional start point, and the destination path. A blank name lets jj derive it from the destination directory name. A blank start point uses jj's native default: the new workspace's working copy commit is created on top of the parent of the current change, so uncommitted work stays in the current workspace. A provided start point must resolve to exactly one commit, mirroring the Git flow's single-commit rule. The suggestion is `~/.worktrees/<repo-root-workspace-name>/<name>` (or `/workspace` when no name was given).

`jj workspace add` requires the destination's parent directory to already exist (it fails with "Cannot access ..." otherwise), so the extension creates the parent chain before invoking jj, matching `git worktree add`'s implicit directory creation. The extension never deletes a directory it did not create: `jj workspace add` may accept an existing empty directory, but this extension still requires the target to not exist, matching the Git flow's stricter preflight.
## ⚙️ Worktree root settings

The machine-local user settings file is:

```text
<getAgentDir()>/pi-worktree.json
```

For a default Pi installation this is typically `~/.pi/agent/pi-worktree.json`. Configure it through **Configure worktree root** or edit it manually:

```json
{
  "worktreeRoot": "~/worktrees"
}
```

`worktreeRoot` accepts `~`, a home-prefixed path such as `~/worktrees`, or a native-platform absolute path. It does not expand `$VAR`, `%VAR%`, or other shell syntax. Empty, relative, NUL-containing, non-string, and invalid paths are rejected. There is no project override or extension-specific environment variable.

A missing `worktreeRoot` uses `~/.worktrees`; the settings file is created only by a successful interactive change. Submitting a blank value in the interactive action removes the override. Within one Pi process, queued saves run in invocation order, reread the latest valid document immediately before merging `worktreeRoot`, and preserve concurrent unknown-field edits. Settings reload on every `session_start`, including `/reload` and workspace replacement; a successful interactive save applies immediately to the next Add flow.

Malformed or invalid settings are warned about but never overwritten, including an invalid edit made while a settings action is open. An initial failure uses `~/.worktrees`; a later failure retains the last valid effective root. Interactive configuration remains blocked until the invalid file is fixed manually. Failed publication leaves the prior file and effective runtime root unchanged, and the save queue remains usable after rejection.

## 🔀 Pi workspace switching

Switching uses Pi's public `SessionManager` and `ctx.switchSession()` APIs:

1. The command waits for Pi to become fully idle so the current assistant/tool results are persisted.
2. A linear persisted session is forked into the target worktree. If `/tree` currently points at an older branch, the documented session entries for that active branch are written to the target instead, so switching cannot jump to a newer serialized leaf.
3. Pi tears down the old cwd-bound runtime and creates the target runtime.
4. The extension reports success only through the fresh replacement-session context.

If the current session is completely empty, the extension creates a valid empty Pi session for the target. If the current session is ephemeral (`--no-session`), the extension copies its active conversation branch into a persisted target session so the workspace switch does not lose context.

A successfully created Git worktree is never rolled back merely because Pi session switching fails. Re-run `/worktree` and choose **Switch worktree** after resolving the reported Pi/session issue.

## 🛡️ Safety boundaries

- The main worktree and current worktree cannot be removed.
- Locked or stale worktrees cannot be removed through this extension.
- Dirty, untracked, initialized-submodule, and intentional `assume-unchanged`/`skip-worktree` index state causes removal to fail closed. Sparse-checkout-managed `skip-worktree` entries outside the active sparsity rules are allowed when Git's rule checker can confirm them; clear other intentional index flags before removing the worktree.
- Ignored-only files and directories do not block removal. The confirmation lists them, and the extension rechecks the exact ignored inventory before Git deletes the worktree.
- A detached HEAD must be reachable from a local branch, tag, or remote ref before removal or prune.
- Removal and prune inspect reflogs, pseudorefs, per-worktree refs, and `FETCH_HEAD`. Historical commits reachable only through this administrative recovery state are listed by full OID in the destructive confirmation; approval removes those recovery pointers, so Git may later garbage-collect the commits. Create a branch or tag instead when any listed commit should survive.
- Staged-only administrative index state, a missing attached branch ref, or an unreachable current detached HEAD still blocks prune without an override.
- Removal never deletes a branch and never uses `--force`.
- Remove invokes only argv-based `git worktree remove <path>`; production runtime never invokes a shell, `rm`, `rm -rf`, or a Node filesystem directory-deletion API for worktrees.
- Prune always runs `git worktree prune --dry-run --verbose` before confirmation, inspects candidates omitted from porcelain, rechecks the exact preview and recovery-risk set after confirmation, and uses Git's default expiry. Remove likewise rechecks worktree identity, inventory, administrative path, and the approved recovery-risk set before mutation.
- The extension does not commit, push, rebase, repair, move, lock, or unlock worktrees.

### Jujutsu workspace boundaries

- The current workspace and the workspace containing the jj repository (the jj analogue of the main worktree) cannot be removed.
- `jj workspace forget` silently abandons the workspace's working copy commit even when it contains uncommitted changes, so Remove only offers workspaces whose working copy commit is empty, visible, and conflict-free.
- Prune only forgets stale workspaces (missing root or abandoned working copy commit). A stale workspace whose working copy commit still holds uncommitted or conflicted changes blocks the whole prune, because forgetting would make those changes unreachable; preserve them with jj first.
- Remove and prune re-list the workspaces and recheck name, path, change id, commit id, and working copy state after confirmation; any change refuses the mutation.
- Forgetting never deletes files: jj has no remove-with-directory operation, so the workspace directory is always retained and reported in the success notification. Use `jj workspace forget` or your shell directly if you also want to delete the directory.
- All reads use `--ignore-working-copy` so listing never snapshots the current working copy; only Add performs a normal jj operation that may snapshot it.
- The extension never invokes a shell and never interpolates user input into jj argv.

Use Git or jj directly when you intentionally need force removal, branch deletion, custom prune expiry, detach/orphan creation, move, repair, lock, or unlock behavior.
## Requirements and limits

- Git worktree mode: Git must be installed and the current Pi cwd must be inside a non-bare Git worktree.
- Jujutsu workspace mode: `jj` must be installed and the current Pi cwd must be inside a jj workspace (any ancestor with a `.jj` directory). The workspace root is re-detected on every command run, so linked workspaces work from anywhere inside them.
- The command requires a UI-capable Pi mode; print and JSON modes cannot drive its dialogs.
- Project trust and cwd-bound extension/resource loading during a switch remain owned by Pi.
- The extension registers no LLM tool, background watcher, project settings, or statusline item.

## 📁 Package layout

```text
packages/pi-worktree/
├── src/
│   ├── index.ts
│   ├── command.ts
│   ├── git.ts
│   ├── jj.ts
│   ├── session.ts
│   ├── settings.ts
│   └── worktree.ts
├── test/
│   ├── command.test.ts
│   ├── git.integration.test.ts
│   ├── git.test.ts
│   ├── jj-command.test.ts
│   ├── jj.integration.test.ts
│   ├── jj.test.ts
│   ├── remove-ignored-command.test.ts
│   ├── session.test.ts
│   └── settings.test.ts
├── package.json
├── README.md
├── LICENSE
└── tsconfig.json
```

## 🏷️ Keywords

`pi-package`, `pi-extension`, `git`, `worktree`, `workspace`, `jj`, `jujutsu`, `session`

## 📄 License

MIT
