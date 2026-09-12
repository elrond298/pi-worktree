# 🌳 pi-worktree — Create, Switch, and Remove Git Worktrees and Jujutsu Workspaces in Pi

> [!IMPORTANT]
> **⚠️ Local fork — this README is the upstream document with local modifications on top.**
> This repository adds Jujutsu workspace support, a `/workspace` alias, and standalone tooling to the upstream [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions) `packages/pi-worktree`.
> See **[LOCAL_CHANGES.md](./LOCAL_CHANGES.md)** for the complete list of local changes and how upstream sync handles them.

## Upstream

- **Upstream repository:** <https://github.com/narumiruna/pi-extensions> (path `packages/pi-worktree`, branch `main`)
- **This fork:** hosted on Gitea at `git@git.thechance.top:ck/pi-worktree.git`
- **Local modifications:** tracked in [LOCAL_CHANGES.md](./LOCAL_CHANGES.md)

[![npm](https://img.shields.io/npm/v/@narumitw/pi-worktree)](https://www.npmjs.com/package/@narumitw/pi-worktree) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Create, inspect, switch, remove, and prune Git worktrees and Jujutsu workspaces through one guarded `/worktree` manager.
Because `cd` cannot change Pi's parent process directory, switching prepares a Pi session whose cwd is the selected worktree or jj workspace and carries over the active conversation when possible.

## ✨ Features

- One command for both VCS families: inside a Jujutsu repo (`jj`), `/worktree` manages jj workspaces; everywhere else it manages Git worktrees.
- Lists main, linked, current, detached, locked, and prunable worktrees with searchable local status details.
- Creates a worktree from a new branch or an unoccupied local branch after showing the exact base commit.
- Suggests a configurable path under `~/.worktrees/` and rejects unsafe, occupied, or ambiguous targets.
- Switches Pi to an existing or newly created worktree while preserving the active conversation when possible.
- Removes only non-current, unlocked worktrees after checking tracked, untracked, index, submodule, and detached-commit risks.
- Shows ignored files and stale metadata before confirmed removal or pruning, then revalidates the approved plan.
- Runs Git and jj through argv-based subprocess calls, without interpolating user input into shell commands.

### Jujutsu workspace support

- Detects jj workspaces by walking ancestors for `.jj`; colocated repositories are managed as jj workspaces because jj owns their workspace layout.
- Lists every workspace with its root path, change id, dirty/conflicted/abandoned working copy state, and current/main markers.
- Creates a workspace at a chosen path with an optional name and an optional start point (default: the parent of the current change, matching `jj workspace add`).
- Switches Pi among registered workspaces, refusing abandoned working copies and missing roots.
- Removes (forgets) only clean, non-current, non-main workspaces. `jj workspace forget` never deletes directories, so the directory is always retained on disk.
- Prunes stale workspaces: forgotten directories (jj can no longer resolve their root) and workspaces whose working copy commit was abandoned. Prune refuses when a stale workspace still holds uncommitted or conflicted changes, because forgetting would silently abandon them.
- Reads state through `jj workspace list --ignore-working-copy -T ...`, so listing never snapshots or mutates the current working copy.

## 🔄 Syncing upstream

This repository vendors the package from the [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) monorepo (`packages/pi-worktree`), with the same files at the root plus local additions (jj support, standalone tooling). The `upstream` git remote tracks the monorepo; because the trees differ, a rebase cannot merge them, so changes are imported file by file:

```bash
node scripts/sync-upstream.mjs           # dry run: fetch + classify every file
node scripts/sync-upstream.mjs --apply   # import safe upstream changes
jj diff                                   # review
jj describe -m "sync: import upstream changes" && jj git push
```

Per file, the script classifies:

- **same** — already matches upstream; nothing to do.
- **update** — upstream changed the file since the version we vendored, and our local copy still equals that vendored version (we never touched it) → imported automatically.
- **new** — upstream added the file → imported automatically.
- **diverged** — our local copy matches no upstream version (we edited it, e.g. `src/command.ts`, `package.json`, tests) → reported for a manual merge, never overwritten.
- **deleted** — upstream removed a file we still carry → reported, left in place.

Local-only files (`src/jj.ts`, the jj tests, `scripts/`, `biome.json`, ...) are never touched. Set `UPSTREAM_REF` to sync from a different upstream ref than `main`.

## 📦 Install

This extension runs Git (or jj) and writes settings and Pi sessions with Pi's process permissions.
Install it only from a source you trust.

```bash
pi install npm:@narumitw/pi-worktree
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-worktree
```

Try this package locally from the repository root:

```bash
pi -e .
```

The package loads directly from `src/index.ts`; no build step is needed.

## 🚀 Quick start

Run `/worktree` in TUI or RPC mode and choose an action.
Before each Git mutation, the extension runs its safety checks and shows the exact change for confirmation.

## 💬 Commands

Run `/worktree` to inspect, create, switch, or remove Git worktrees (or jj workspaces), prune stale metadata, and configure the default root in TUI or RPC mode.
It accepts no arguments; print and JSON modes reject it before any VCS call.
Git (or jj) must be installed and Pi must be inside a non-bare worktree.
Destructive changes require confirmation and never delete branches; review [Safety boundaries](#️-safety-boundaries), including ignored-file and recovery-pointer loss.
See [Add defaults](#-add-defaults) for creation rules and [Pi workspace switching](#-pi-workspace-switching) for conversation transfer and failure recovery.

`/workspace` is an alias for `/worktree`; both names open the same menu. The
command is VCS-aware: inside a Jujutsu repo it manages jj workspaces,
everywhere else it manages Git worktrees.

Choose one action (labels use *workspace* wording inside jj repositories):

- **Worktree status** — browse a local snapshot for every registered worktree without fetching remotes.
- **Add worktree / workspace** — for Git: enter a branch, optional start point, and optional path; review exact base provenance, confirm creation, and optionally switch. For jj: enter an optional workspace name, an optional start point, and a path.
- **Switch worktree / workspace** — search for another existing worktree or workspace by displayed path, branch (or name), or HEAD and continue this Pi conversation there.
- **Remove worktree / workspace** — Git: search for a linked worktree by displayed path, branch, or HEAD, then remove it without deleting its branch; ignored-only data is listed for explicit confirmation. jj: forget a clean workspace; its directory is retained.
- **Prune stale metadata / workspaces** — Git: inspect `git worktree prune --dry-run --verbose`, then optionally run the matching prune. jj: preview stale workspaces (missing roots or abandoned working copies), then forget them together.
- **Configure worktree root** — set a machine-local default root or submit a blank value to restore `~/.worktrees`.

## 🌿 Add defaults

For a new branch, the current symbolic branch is the default start point.
If Pi is running from detached HEAD, the command requires an explicit commit-ish.
Git must resolve the start point to exactly one commit.

Before mutation, Add identifies whether the branch is new or existing.
It shows the current branch, explicit commit-ish, or existing local branch used as provenance, plus the full resolved OID and target path.
New branches are created from that approved OID even if the source ref later moves.
Existing branches are checked again immediately before mutation and the created worktree HEAD is verified afterward.
Git has no atomic compare-and-add operation for attaching an existing branch, so a post-add mismatch is retained for inspection rather than rolled back.

### Jujutsu add flow

In a jj repository the Add flow asks for an optional workspace name, an optional start point, and the destination path. A blank name lets jj derive it from the destination directory name. A blank start point uses jj's native default: the new workspace's working copy commit is created on top of the parent of the current change, so uncommitted work stays in the current workspace. A provided start point must resolve to exactly one commit, mirroring the Git flow's single-commit rule. The suggestion is `~/.worktrees/<repo-root-workspace-name>/<name>` (or `/workspace` when no name was given).

`jj workspace add` requires the destination's parent directory to already exist (it fails with "Cannot access ..." otherwise), so the extension creates the parent chain before invoking jj, matching `git worktree add`'s implicit directory creation. The extension never deletes a directory it did not create: `jj workspace add` may accept an existing empty directory, but this extension still requires the target to not exist, matching the Git flow's stricter preflight.

The default root is `~/.worktrees`, where `~` is Node's platform home directory.
Suggestions use the registered main worktree's directory name, not the current linked-worktree cwd:

```text
main worktree: /home/user/workspace/project
branch:        feat/login
root:          /home/user/.worktrees
suggested:     /home/user/.worktrees/project/feat-login
```

On Windows, the equivalent default is such as `C:\Users\Alice\.worktrees`.
Branch `/` characters become `-`.
The extension does not add hashes or collision suffixes.
If normalized paths collide or the target already exists, Add stops before mutating Git state.

Leave the path input blank to accept the suggestion.
A custom absolute path is used directly; a custom relative path is resolved from the current Pi cwd.
The target itself must not exist, and its nearest existing ancestor must resolve without a broken or looping symbolic link.
Existing registered worktrees are never moved when this default changes.

The MVP does not expose `--force`, `-B`, `--detach`, `--orphan`, or lock options.

## ⚙️ Settings

The machine-local user settings file is:

```text
<getAgentDir()>/pi-worktree.json
```

For a default Pi installation this is typically `~/.pi/agent/pi-worktree.json`.
Configure it through **Configure worktree root** or edit it manually:

```json
{
  "worktreeRoot": "~/worktrees"
}
```

`worktreeRoot` accepts `~`, a home-prefixed path such as `~/worktrees`, or a native-platform absolute path.
It does not expand `$VAR`, `%VAR%`, or other shell syntax.
Empty, relative, NUL-containing, non-string, and invalid paths are rejected.
There is no project override or extension-specific environment variable.

A missing `worktreeRoot` uses `~/.worktrees`.
A successful interactive change is the only operation that creates the settings file.
Submitting a blank value in the interactive action removes the override.
Within one Pi process, queued saves run in invocation order.
Each save rereads the latest valid document before merging `worktreeRoot` and preserves concurrent edits to unknown fields.
Settings reload on every `session_start`, including `/reload` and workspace replacement; a successful interactive save applies immediately to the next Add flow.

Malformed or invalid settings are warned about but never overwritten, including an invalid edit made while a settings action is open.
An initial failure uses `~/.worktrees`; a later failure retains the last valid effective root.
Interactive configuration remains blocked until the invalid file is fixed manually.
Failed publication leaves the prior file and effective runtime root unchanged, and the save queue remains usable after rejection.

## 🔀 Pi workspace switching

Switching uses Pi's public `SessionManager` and `ctx.switchSession()` APIs in this order:

1. The command waits for Pi to become fully idle so the current assistant/tool results are persisted.
2. A linear persisted session is forked into the target worktree.
   If `/tree` points at an older branch, only that active branch's documented session entries are written to the target.
   Switching therefore cannot jump to a newer serialized leaf.
3. Pi tears down the old cwd-bound runtime and creates the target runtime.
4. The extension reports success only through the fresh replacement-session context.

If the current session is completely empty, the extension creates a valid empty Pi session for the target.
For an ephemeral session created with `--no-session`, the extension copies the active conversation branch into a persisted target session.
This preserves context across the workspace switch.

If switching fails after Add, the extension retains the successfully created Git worktree.
If Pi prepared a target session before the failure, it retains that session too.
Resolve the reported Pi or session issue, then run `/worktree` and choose **Switch worktree**.

## 🛡️ Safety boundaries

- The main worktree and current worktree cannot be removed.
- Locked or stale worktrees cannot be removed through this extension.
- Dirty, untracked, initialized-submodule, and intentional `assume-unchanged`/`skip-worktree` index state causes removal to fail closed.
  Sparse-checkout-managed `skip-worktree` entries outside the active sparsity rules are allowed when Git's rule checker confirms them.
  Clear other intentional index flags before removing the worktree.
- Ignored-only files and directories do not block removal.
  The confirmation lists them, and the extension rechecks the exact ignored inventory before Git deletes the worktree.
- A detached HEAD must be reachable from a local branch, tag, or remote ref before removal or prune.
- Removal and prune inspect reflogs, pseudorefs, per-worktree refs, and `FETCH_HEAD`.
  Historical commits reachable only through this administrative recovery state are listed by full OID in the destructive confirmation.
  Approval removes those recovery pointers, so Git may later garbage-collect the commits.
  Create a branch or tag instead when any listed commit should survive.
- Staged-only administrative index state, a missing attached branch ref, or an unreachable current detached HEAD still blocks prune without an override.
- Removal never deletes a branch and never uses `--force`.
- Remove invokes only argv-based `git worktree remove <path>`; production runtime never invokes a shell, `rm`, `rm -rf`, or a Node filesystem directory-deletion API for worktrees.
- Prune runs `git worktree prune --dry-run --verbose`, inspects candidates omitted from porcelain, and shows the result before confirmation.
  After confirmation, it rechecks the exact preview and recovery-risk set before pruning with Git's default expiry.
  Remove likewise rechecks worktree identity, inventory, administrative path, and the approved recovery-risk set before mutation.
- The status browser uses only local Git state and never fetches a remote; its cards never authorize Remove or Prune.
- The extension does not commit, push, fetch, rebase, repair, move, lock, or unlock worktrees.

### Jujutsu workspace boundaries

- The current workspace and the workspace containing the jj repository (the jj analogue of the main worktree) cannot be removed.
- `jj workspace forget` silently abandons the workspace's working copy commit even when it contains uncommitted changes, so Remove only offers workspaces whose working copy commit is empty, visible, and conflict-free.
- Prune only forgets stale workspaces (missing root or abandoned working copy commit). A stale workspace whose working copy commit still holds uncommitted or conflicted changes blocks the whole prune, because forgetting would make those changes unreachable; preserve them with jj first.
- Remove and prune re-list the workspaces and recheck name, path, change id, commit id, and working copy state after confirmation; any change refuses the mutation.
- Forgetting never deletes files: jj has no remove-with-directory operation, so the workspace directory is always retained and reported in the success notification. Use `jj workspace forget` or your shell directly if you also want to delete the directory.
- All reads use `--ignore-working-copy` so listing never snapshots the current working copy; only Add performs a normal jj operation that may snapshot it.
- The extension never invokes a shell and never interpolates user input into jj argv.

Status is an on-demand local snapshot of each worktree's state, full HEAD, working-tree counts, upstream divergence, and last commit.
Unavailable worktrees remain visible with a reason.
A missing upstream means **not configured**, not proof that no commits are unpushed.
Snapshots can become stale immediately and never replace the stricter Remove and Prune checks.

Use Git or jj directly when you intentionally need force removal, branch deletion, custom prune expiry, detach/orphan creation, move, repair, lock, unlock, or remote refresh behavior.

## 🚧 Limitations

- Git worktree mode: Git must be installed and the current Pi cwd must be inside a non-bare Git worktree.
- Jujutsu workspace mode: `jj` must be installed and the current Pi cwd must be inside a jj workspace (any ancestor with a `.jj` directory). The workspace root is re-detected on every command run, so linked workspaces work from anywhere inside them.
- The command requires a UI-capable Pi mode; print and JSON modes cannot drive its dialogs.
- Project trust and cwd-bound extension/resource loading during a switch remain owned by Pi.
- The extension registers no LLM tool, background watcher, project settings, or statusline item.

## 📁 Package layout

```text
./
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── jj.ts                          # Jujutsu workspace backend
│   └── worktree.ts                    # Worktree manager and lifecycle
├── scripts/                           # Standalone tooling (upstream sync, test runner)
└── test/                              # Behavior and lifecycle coverage
```

## 🏷️ Keywords

`pi-package`, `pi-extension`, `git`, `worktree`, `workspace`, `jj`, `jujutsu`, `session`

## 📄 License

[MIT](./LICENSE)
