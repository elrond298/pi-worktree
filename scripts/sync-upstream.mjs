#!/usr/bin/env node

// Sync the vendored pi-worktree package with the upstream monorepo.
//
// Upstream (narumiruna/pi-extensions) keeps this package at
// packages/pi-worktree, while this repository vendors the same files at the
// root. A plain rebase cannot merge the two trees, so this script imports
// upstream changes file by file:
//
//   node scripts/sync-upstream.mjs           # dry run: fetch + classify
//   node scripts/sync-upstream.mjs --apply   # import safe upstream files
//
// Classification per upstream file:
//   same       local content already matches upstream/main
//   update     upstream changed the file since the version we vendored, and
//              our local copy still equals that vendored version (we never
//              touched it) -> safe to import
//   new        upstream added the file and we do not have it -> safe to import
//   diverged   our local copy matches no upstream version (we edited it) ->
//              reported for manual merging, never overwritten
//
// Files upstream deleted are only reported; local-only files are never touched.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_REF = process.env.UPSTREAM_REF ?? "upstream/main";
const UPSTREAM_DIR = "packages/pi-worktree";
const MAX_HISTORY_SCAN = 200;
const apply = process.argv.includes("--apply");

function git(args, allowFailure = false) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0 && !allowFailure) {
		console.error(result.stderr.trim() || result.stdout.trim());
		process.exit(1);
	}
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function nonEmptyLines(value) {
	return value.split("\n").filter((line) => line.length > 0);
}

console.log(`Fetching ${UPSTREAM_REMOTE}...`);
git(["fetch", UPSTREAM_REMOTE]);

const ref = git(["rev-parse", "--verify", UPSTREAM_REF]);
if (!ref.ok) {
	console.error(`Upstream ref ${UPSTREAM_REF} was not found after fetching.`);
	process.exit(1);
}
const upstreamCommit = ref.stdout.trim();
const upstreamShort = upstreamCommit.slice(0, 8);

const upstreamFiles = nonEmptyLines(
	git(["ls-tree", "-r", "--name-only", UPSTREAM_REF, "--", UPSTREAM_DIR]).stdout,
).map((path) => path.slice(UPSTREAM_DIR.length + 1));
const upstreamSet = new Set(upstreamFiles);
const trackedFiles = nonEmptyLines(git(["ls-files"]).stdout);

function localContent(file) {
	const path = join(root, file);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function upstreamContentAt(commit, file) {
	const result = git(["show", `${commit}:${UPSTREAM_DIR}/${file}`], true);
	return result.ok ? result.stdout : undefined;
}

function findVendoredBase(file, local) {
	// Most recent upstream commit whose version of the file matches our local
	// copy. Found => upstream changed the file after we vendored it and we did
	// not touch it since; missing => our copy diverges from every upstream
	// version.
	const commits = nonEmptyLines(
		git(["log", "--follow", "--format=%H", UPSTREAM_REF, "--", `${UPSTREAM_DIR}/${file}`]).stdout,
	);
	for (const commit of commits.slice(0, MAX_HISTORY_SCAN)) {
		if (upstreamContentAt(commit, file) === local) return commit;
	}
	return undefined;
}

const updates = [];
const additions = [];
const diverged = [];
const same = [];
let scanned = 0;

for (const file of upstreamFiles) {
	const local = localContent(file);
	if (local === undefined) {
		additions.push(file);
		continue;
	}
	const upstream = upstreamContentAt(upstreamCommit, file);
	if (upstream === local) {
		same.push(file);
		continue;
	}
	scanned += 1;
	const base = findVendoredBase(file, local);
	if (base === undefined) diverged.push(file);
	else updates.push({ file, from: base.slice(0, 8) });
}

// Upstream deletions: tracked locally, absent upstream, but present in
// upstream history (files that never existed upstream are local-only).
const deletions = [];
for (const file of trackedFiles) {
	if (upstreamSet.has(file)) continue;
	if (localContent(file) === undefined) continue;
	const history = git(
		["log", "--follow", "--format=%H", UPSTREAM_REF, "--", `${UPSTREAM_DIR}/${file}`],
		true,
	);
	if (history.ok && history.stdout.trim().length > 0) deletions.push(file);
}

console.log(`\nUpstream ${UPSTREAM_REF} (${upstreamShort}): ${upstreamFiles.length} files\n`);
console.log(`same:       ${same.length}`);
console.log(
	`update:     ${updates.length}${updates.length > 0 ? ` (${updates.map((u) => u.file).join(", ")})` : ""}`,
);
console.log(
	`new:        ${additions.length}${additions.length > 0 ? ` (${additions.join(", ")})` : ""}`,
);
console.log(
	`diverged:   ${diverged.length}${diverged.length > 0 ? ` (${diverged.join(", ")})` : ""}`,
);
console.log(
	`deleted:    ${deletions.length}${deletions.length > 0 ? ` (${deletions.join(", ")})` : ""}`,
);
if (scanned > MAX_HISTORY_SCAN) {
	console.log(
		`\nnote: history scan capped at ${MAX_HISTORY_SCAN} commits per file; some files may be reported diverged even if untouched.`,
	);
}

if (!apply) {
	console.log("\nDry run: pass --apply to import the update/new files into the working copy.");
	process.exit(0);
}

if (updates.length + additions.length === 0) {
	console.log("\nNothing to import.");
	process.exit(0);
}

for (const { file } of updates) {
	const path = join(root, file);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.sync-tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporary, upstreamContentAt(upstreamCommit, file) ?? "", { encoding: "utf8" });
	renameSync(temporary, path);
	console.log(`updated ${file}`);
}
for (const file of additions) {
	const path = join(root, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, upstreamContentAt(upstreamCommit, file) ?? "", { encoding: "utf8" });
	console.log(`added  ${file}`);
}

console.log(
	`\nImported ${updates.length + additions.length} file(s) from ${upstreamShort}. Review with 'jj diff', then commit.`,
);
if (diverged.length > 0) {
	console.log(
		`\nDiverged files were left untouched (${diverged.join(", ")}). Merge them manually, e.g.:\n  git show ${upstreamShort}:packages/pi-worktree/<file> > /tmp/upstream-<file>\n  jj diff <file>`,
	);
}
if (deletions.length > 0) {
	console.log(`\nUpstream deleted these files (left in place): ${deletions.join(", ")}`);
}
