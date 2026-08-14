# 🔧 Local Changes (vs. upstream)

This repository vendors the `pi-worktree` package from the
[narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) monorepo
(`packages/pi-worktree`), keeping the upstream files at the repository root.
The upstream README is kept in place; **this file documents every local
modification** and how upstream sync treats it. The README's top banner links
here.

## Upstream source

- Repository: https://github.com/narumiruna/pi-extensions
- Path upstream: `packages/pi-worktree`
- Default ref: `main` (override with `UPSTREAM_REF`)
- Git remote: `upstream` (fetch-only; origin is this fork)
- Last synced upstream commit: `a5ee05de` (2026-08; brought the worktree status
  browser, searchable selectors, add-base provenance, and the vitest test
  split)
## Summary of local modifications

### 1. Jujutsu workspace support (the main addition)

The upstream package manages Git worktrees only. This fork adds full jj
workspace support, making `/worktree` VCS-aware:

- `src/jj.ts` — new module: workspace detection, listing, add, switch, remove
  (forget), and prune via argv-based `jj` subprocess calls.
- `src/command.ts` — diverged: dispatches to the Git or jj flow based on repo
  type, adds the `/workspace` alias, and extends the menus, preflights, and
  confirmations with jj wording and rules.
- `test/jj.test.ts`, `test/jj-command.test.ts`, `test/jj.integration.test.ts`,
  `test/support.ts` — new jj test suites.
- `test/command.test.ts`, `test/git.test.ts`,
  `test/remove-ignored-command.test.ts`, `test/session.test.ts` — updated for
  the jj-aware flows.
- All upstream tests are adapted on every sync from the monorepo's vitest
  harness to this fork's standalone `node:test` harness: `vitest` imports
  become `node:test` and monorepo-relative `../../../test/support.js` imports
  become `./support.js` (currently applied to `test/add-command.test.ts`,
  `test/settings-command.test.ts`, `test/status-command.test.ts`,
  `test/status.test.ts`, `test/git.integration.test.ts`, `test/settings.test.ts`).

### 2. `/workspace` alias

`/workspace` is registered as an alias for `/worktree`; both open the same
VCS-aware menu.

### 3. Standalone tooling

The upstream package lives inside a monorepo (root tsconfig, pnpm, `just`
recipes). This fork is self-contained:

- `scripts/sync-upstream.mjs` — fetches and classifies every upstream file
  (same / update / new / diverged / deleted) and imports safe changes.
- `scripts/run-tests.mjs` — compiles tests to `node_modules/.cache/` and runs
  them without a monorepo harness.
- `biome.json` — standalone Biome config (tabs, 100 cols, double quotes).
- `tsconfig.json` — standalone compiler options (no monorepo `extends`).
- `tsconfig.test.json` — test build config with an emit target.
- `.gitignore` — `node_modules/`, `node_modules/.cache/`, `*.tsbuildinfo`.

### 4. `package.json`

- Description and keywords now mention Jujutsu (`jj`, `jujutsu`).
- Scripts: `check`/`format` cover the new files; `typecheck` builds both
  tsconfigs; `test` runs `node scripts/run-tests.mjs`.
- DevDependency added: `@earendil-works/pi-tui`.

### 5. `README.md` (this repository's copy)

- Documents the Jujutsu workspace support, the syncing workflow, and jj safety
  boundaries.
- Carries the notice banner at the top that links to this file.

## How upstream sync treats local changes

| Status                    | Files                                                                  | Sync behavior                          |
| ------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| **local-only** (new here) | `src/jj.ts`, jj tests, `test/support.ts`, `scripts/`, `biome.json`, `tsconfig.test.json`, `.gitignore` | never touched                          |
| **diverged** (edited)     | `src/command.ts`, `package.json`, `tsconfig.json`, `README.md`, git/test files listed above | reported for a manual merge, never overwritten |
| **update / new**          | any upstream file we never touched                                     | imported automatically by `--apply`    |

Because `README.md` is edited here, upstream README changes are classified as
**diverged** and must be merged manually — the sync script never overwrites it.
When merging an upstream README update, keep the top banner and the jj sections
intact.

## Keeping this fork in sync

```bash
node scripts/sync-upstream.mjs           # dry run: fetch + classify every file
node scripts/sync-upstream.mjs --apply   # import safe upstream changes
jj diff                                   # review
jj describe -m "sync: import upstream changes" && jj git push
```

Merge any **diverged** files by hand, e.g.:

```bash
git show upstream/main:packages/pi-worktree/README.md > /tmp/upstream-README.md
jj diff README.md
```

## Change log

Every local modification to this fork, newest first:

| Date       | Change                                                                 | Commit    |
|------------|------------------------------------------------------------------------|-----------|
| 2026-08-14 | Sync: port upstream changes (status browser, searchable selectors, add-base provenance, vitest test split) | `84e1d500` |
| 2026-08-07 | Document local fork modifications in LOCAL_CHANGES.md                  | `dc3f5b74` |
| 2026-08-07 | Add upstream sync script (`scripts/sync-upstream.mjs`)                 | `f2eb4ee2` |
| 2026-08-07 | Register `/workspace` as an alias for `/worktree`                      | `04e59e81` |
| 2026-08-07 | Create missing parent directories before `jj workspace add`            | `8e17bdde` |
| 2026-08-07 | Add Jujutsu workspace support (detection, list/add/switch/remove/prune) | `c2589c10` |
| 2026-08-07 | Import `@narumitw/pi-worktree` from `narumiruna/pi-extensions`         | `93932acf` |
