import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	addJjWorkspace,
	currentJjWorkspaceRoot,
	detectVcs,
	forgetJjWorkspaces,
	jjRepoRoot,
	listJjWorkspaces,
	resolveJjRevision,
} from "../src/jj.js";

const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf8" }).status === 0;

const pi = {
	async exec(command: string, args: string[], options?: { cwd?: string }): Promise<ExecResult> {
		const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
		if (result.error) throw result.error;
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.status ?? 1,
			killed: Boolean(result.signal),
		};
	},
};

function jj(cwd: string, args: string[]) {
	const result = spawnSync("jj", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`jj ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result;
}

test("jj service lists, adds, switches into, and forgets workspaces in a real repository", {
	skip: jjAvailable ? false : "jj is not installed",
}, async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jj-integration-")));
	const main = join(temporary, "main");
	const linked = join(temporary, "feat");
	try {
		jj(temporary, ["git", "init", "--colocate", main]);
		jj(main, ["describe", "-m", "main change"]);
		writeFileSync(join(main, "README.md"), "main\n");
		jj(main, ["commit", "-m", "add readme"]);

		assert.equal(detectVcs(main), "jj");
		assert.equal(jjRepoRoot(main), main);
		assert.equal(await currentJjWorkspaceRoot(pi, main), main);

		const before = await listJjWorkspaces(pi, main);
		assert.ok(before.some((record) => record.name === "default"));
		assert.ok(before.every((record) => record.path !== undefined));

		const startCommit = await resolveJjRevision(pi, main, "@-");
		assert.match(startCommit, /^[0-9a-f]{40}$/u);
		await addJjWorkspace(pi, main, { path: linked, name: "feat", startCommit });

		const afterAdd = await listJjWorkspaces(pi, main);
		const created = afterAdd.find((record) => record.name === "feat");
		assert.ok(created);
		assert.equal(created?.path, linked);
		assert.equal(created?.empty, true);

		// The new workspace is a real working copy that jj can operate on.
		jj(linked, ["describe", "-m", "linked change"]);
		assert.equal(
			(await listJjWorkspaces(pi, main)).find((record) => record.name === "feat")?.description,
			"linked change",
		);

		await forgetJjWorkspaces(pi, main, ["feat"]);
		const afterForget = await listJjWorkspaces(pi, main);
		assert.equal(
			afterForget.some((record) => record.name === "feat"),
			false,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("jj service reports missing roots as stale and forgets them safely", {
	skip: jjAvailable ? false : "jj is not installed",
}, async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jj-stale-")));
	const main = join(temporary, "main");
	const gone = join(temporary, "gone");
	try {
		jj(temporary, ["git", "init", "--colocate", main]);
		jj(main, ["describe", "-m", "main change"]);
		jj(main, ["workspace", "add", gone]);

		// Deleting the directory makes jj unable to resolve the workspace root.
		rmSync(gone, { recursive: true, force: true });
		const records = await listJjWorkspaces(pi, main);
		const stale = records.find((record) => record.name === "gone");
		assert.ok(stale);
		assert.equal(stale?.path, undefined);
		assert.equal(stale?.empty, true);

		await forgetJjWorkspaces(pi, main, ["gone"]);
		const after = await listJjWorkspaces(pi, main);
		assert.equal(
			after.some((record) => record.name === "gone"),
			false,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("jj service fails closed outside a jj repository", {
	skip: jjAvailable ? false : "jj is not installed",
}, async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jj-norepo-")));
	try {
		assert.equal(detectVcs(temporary), "git");
		await assert.rejects(listJjWorkspaces(pi, temporary), /not inside a Jujutsu repository/i);
		await assert.rejects(resolveJjRevision(pi, temporary, "@"), /not inside a Jujutsu repository/i);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
