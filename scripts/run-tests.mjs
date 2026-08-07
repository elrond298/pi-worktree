#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "pi-worktree-test");
const tsc = path.join(
	root,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

fs.rmSync(outDir, { recursive: true, force: true });
run(tsc, ["-p", "tsconfig.test.json"]);
const testFiles = findFiles(outDir, ".test.js");
if (testFiles.length === 0) {
	console.error("No compiled test files found.");
	process.exit(1);
}
const canonicalTempDir = fs.realpathSync(os.tmpdir());
run(process.execPath, ["--test", ...testFiles], {
	...process.env,
	TMPDIR: canonicalTempDir,
	TMP: canonicalTempDir,
	TEMP: canonicalTempDir,
});

function run(command, args, env = process.env) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function findFiles(directory, suffix) {
	if (!fs.existsSync(directory)) return [];
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix));
		else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
	}
	return files.sort();
}
