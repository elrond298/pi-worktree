import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	addJjWorkspace,
	buildJjAddArguments,
	currentJjWorkspaceRoot,
	defaultJjWorkspacePath,
	detectVcs,
	findJjWorkspaceRoot,
	forgetJjWorkspaces,
	formatJjWorkspace,
	jjRepoRoot,
	listJjWorkspaces,
	parseJjWorkspaceList,
	resolveJjRevision,
	sameJjWorkspaceIdentity,
	validateJjWorkspaceName,
} from "../src/jj.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

function workspaceLine(fields: Array<string | undefined>): string {
	const parts = [
		fields[0] ?? "default",
		fields[1] ?? "/repo/default",
		fields[2] ?? "kkmpptxz",
		fields[3] ?? oid.slice(0, 12),
		fields[4] ?? "empty",
		fields[5] ?? "ok",
		fields[6] ?? "visible",
		fields[7] ?? "",
	];
	return parts.join("\0");
}

function execResult(result: Partial<ExecResult> = {}): ExecResult {
	return { stdout: "", stderr: "", code: 0, killed: false, ...result };
}

test("parseJjWorkspaceList parses NUL-separated records and preserves paths with spaces", () => {
	const output = [
		workspaceLine([
			"default",
			"/repo with spaces",
			"kkmpptxz",
			"abc",
			"empty",
			"ok",
			"visible",
			"main work",
		]),
		workspaceLine([
			"feat-login",
			"/repo with spaces/.worktrees/feat-login",
			"qpmtlqsu",
			"def",
			"dirty",
			"conflict",
			"visible",
			"",
		]),
		"",
	].join("\n");

	const records = parseJjWorkspaceList(output);
	assert.equal(records.length, 2);
	assert.deepEqual(records[0], {
		name: "default",
		path: "/repo with spaces",
		changeId: "kkmpptxz",
		commitId: "abc",
		empty: true,
		conflict: false,
		abandoned: false,
		description: "main work",
	});
	assert.equal(records[1]?.path, "/repo with spaces/.worktrees/feat-login");
	assert.equal(records[1]?.empty, false);
	assert.equal(records[1]?.conflict, true);
	assert.equal(records[1]?.description, "");
});

test("parseJjWorkspaceList treats an unresolved root render as a stale workspace", () => {
	const output = [
		workspaceLine([
			"gone",
			"<Error: Failed to resolve workspace root: gone: No such file or directory>",
		]),
		workspaceLine(["alive", "/repo/alive"]),
	].join("\n");

	const records = parseJjWorkspaceList(output);
	assert.equal(records[0]?.name, "gone");
	assert.equal(records[0]?.path, undefined);
	assert.equal(records[1]?.path, "/repo/alive");
});

test("parseJjWorkspaceList rejects malformed records without partial results", () => {
	assert.throws(() => parseJjWorkspaceList("default\0/repo\n"), /malformed workspace list/i);
	assert.throws(
		() => parseJjWorkspaceList(workspaceLine(["", "/repo"]) + "\n"),
		/missing identity fields/i,
	);
	assert.throws(
		() => parseJjWorkspaceList(workspaceLine(["x", "/repo", "not-hex"]) + "\n"),
		/malformed commit identifiers/i,
	);
	assert.throws(
		() => parseJjWorkspaceList(workspaceLine(["x", "/repo", "kkmpptxz", "abc", "weird"]) + "\n"),
		/unexpected working copy state token/i,
	);
	assert.throws(
		() =>
			parseJjWorkspaceList(
				workspaceLine(["x", "/repo", "kkmpptxz", "abc", "empty", "weird"]) + "\n",
			),
		/unexpected conflict state token/i,
	);
	assert.throws(
		() =>
			parseJjWorkspaceList(
				workspaceLine(["x", "/repo", "kkmpptxz", "abc", "empty", "ok", "weird"]) + "\n",
			),
		/unexpected working copy visibility token/i,
	);
});

test("detectVcs prefers the closest jj workspace over a colocated git repo", () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-vcs-")));
	try {
		const jjRoot = join(temporary, "jj-repo");
		const nested = join(jjRoot, "nested", "deeper");
		mkdirSync(join(jjRoot, ".jj"), { recursive: true });
		mkdirSync(join(jjRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		assert.equal(detectVcs(nested), "jj");
		assert.equal(findJjWorkspaceRoot(nested), jjRoot);
		assert.equal(detectVcs(temporary), "git");
		assert.equal(findJjWorkspaceRoot(temporary), undefined);
		assert.equal(jjRepoRoot(temporary), undefined);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("jjRepoRoot returns the repo-root workspace and follows linked workspace pointers", () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jjroot-")));
	try {
		const main = join(temporary, "main");
		const linked = join(temporary, "linked");
		mkdirSync(join(main, ".jj", "repo"), { recursive: true });
		mkdirSync(join(linked, ".jj"), { recursive: true });
		writeFileSync(join(linked, ".jj", "repo"), "../main/.jj/repo\n");

		assert.equal(jjRepoRoot(main), main);
		assert.equal(jjRepoRoot(linked), main);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("jjRepoRoot fails closed on missing or malformed repo pointers", () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jjroot-bad-")));
	try {
		const broken = join(temporary, "broken");
		mkdirSync(join(broken, ".jj"), { recursive: true });
		assert.throws(() => jjRepoRoot(broken), /missing its \.jj\/repo entry/i);

		writeFileSync(join(broken, ".jj", "repo"), "");
		assert.throws(() => jjRepoRoot(broken), /pointer is empty/i);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("buildJjAddArguments emits only safe argv for plain, named, and start-point adds", () => {
	assert.deepEqual(buildJjAddArguments({ path: "/tmp/repo-feat" }), [
		"workspace",
		"add",
		"/tmp/repo-feat",
	]);
	assert.deepEqual(buildJjAddArguments({ path: "/tmp/repo-feat", name: "feat" }), [
		"workspace",
		"add",
		"/tmp/repo-feat",
		"--name",
		"feat",
	]);
	assert.deepEqual(
		buildJjAddArguments({ path: "/tmp/repo-feat", name: "feat", startCommit: oid }),
		["workspace", "add", "/tmp/repo-feat", "--name", "feat", "-r", oid],
	);
});

test("validateJjWorkspaceName accepts normal names and rejects separators and controls", () => {
	assert.equal(validateJjWorkspaceName("  my-change  "), "my-change");
	assert.equal(validateJjWorkspaceName("my-change"), "my-change");
	assert.throws(() => validateJjWorkspaceName("   "), /required/i);
	assert.throws(() => validateJjWorkspaceName("feat/login"), /path separators/i);
	assert.throws(() => validateJjWorkspaceName("feat\\login"), /path separators/i);
	assert.throws(() => validateJjWorkspaceName("bad\u001bname"), /control characters/i);
	assert.throws(() => validateJjWorkspaceName("."), /not be \. or \.\./i);
	assert.throws(() => validateJjWorkspaceName(".."), /not be \. or \.\./i);
});

test("defaultJjWorkspacePath derives root/project/name and normalizes the project leaf", () => {
	assert.equal(
		defaultJjWorkspacePath("/home/me/project", "feat-login", "/home/me/.worktrees"),
		join("/home/me", ".worktrees", "project", "feat-login"),
	);
	assert.equal(
		defaultJjWorkspacePath("/home/me/project", "workspace", "/home/me/.worktrees"),
		join("/home/me", ".worktrees", "project", "workspace"),
	);
});

test("formatJjWorkspace labels current, main, prunable, conflict, and dirty state and strips controls", () => {
	const record = {
		name: "feat",
		path: "/repo/feat",
		changeId: "kkmpptxz",
		commitId: oid.slice(0, 12),
		empty: false,
		conflict: true,
		abandoned: false,
		description: "spoof\u001b[2J",
	};
	const rendered = formatJjWorkspace(record, "/repo/feat", "/repo/feat");
	assert.match(rendered, /\[current, main, conflict, dirty\]/);
	assert.equal(
		[...rendered].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		}),
		false,
	);
	assert.match(
		formatJjWorkspace(
			{ ...record, path: undefined, name: "gone", empty: true, conflict: false },
			"/repo/feat",
			"/repo",
		),
		/\[prunable: root missing\] {2}kkmpptxz/,
	);
	assert.match(
		formatJjWorkspace({ ...record, abandoned: true, empty: true, conflict: false }),
		/prunable: working copy abandoned/,
	);
});

test("sameJjWorkspaceIdentity binds name, path, commits, and working copy state", () => {
	const record = {
		name: "feat",
		path: "/repo/feat",
		changeId: "kkmpptxz",
		commitId: oid.slice(0, 12),
		empty: true,
		conflict: false,
		abandoned: false,
		description: "",
	};
	assert.equal(sameJjWorkspaceIdentity(record, { ...record }), true);
	for (const changed of [
		{ name: "other" },
		{ path: "/other" },
		{ changeId: "qpmtlqsu" },
		{ commitId: "fedcba987654" },
		{ empty: false },
		{ conflict: true },
		{ abandoned: true },
	]) {
		assert.equal(sameJjWorkspaceIdentity(record, { ...record, ...changed }), false);
	}
	assert.equal(
		sameJjWorkspaceIdentity({ ...record, path: undefined }, { ...record, path: undefined }),
		true,
	);
	assert.equal(sameJjWorkspaceIdentity(record, { ...record, path: undefined }), false);
});

test("listJjWorkspaces uses the ignore-working-copy template argv", async () => {
	let called = false;
	const result = await listJjWorkspaces(
		{
			exec: async (_command, args) => {
				called = true;
				assert.equal(args[0], "workspace");
				assert.equal(args[1], "list");
				assert.ok(args.includes("--ignore-working-copy"));
				assert.ok(args.includes("-T"));
				return execResult({ stdout: workspaceLine([]) + "\n" });
			},
		},
		"/repo",
	);
	assert.equal(called, true);
	assert.equal(result.length, 1);
});

test("currentJjWorkspaceRoot strips only jj's line ending and keeps trailing spaces", async () => {
	const path = await currentJjWorkspaceRoot(
		{
			exec: async () => execResult({ stdout: "/repo trailing  \n" }),
		},
		"/repo trailing  ",
	);
	assert.equal(path, "/repo trailing  ");
});

test("resolveJjRevision requires exactly one well-formed commit id", async () => {
	let calls = 0;
	const pi = {
		exec: async () => {
			calls += 1;
			return execResult({ stdout: `${oid}\n` });
		},
	};
	assert.equal(await resolveJjRevision(pi, "/repo", "@-"), oid);
	assert.equal(calls, 1);

	await assert.rejects(
		resolveJjRevision(
			{
				exec: async () => execResult({ stdout: `${oid}\n${oid}\n` }),
			},
			"/repo",
			"a::b",
		),
		/must resolve to exactly one commit/i,
	);
	await assert.rejects(
		resolveJjRevision(
			{
				exec: async () => execResult({ stdout: "not-an-oid\n" }),
			},
			"/repo",
			"bad",
		),
		/invalid commit object/i,
	);
});

test("addJjWorkspace creates a missing parent chain before emitting argv", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-jj-parent-")));
	const nested = join(temporary, "a", "b", "workspace");
	const calls: string[][] = [];
	const pi = {
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return execResult();
		},
	};
	try {
		await addJjWorkspace(pi, temporary, { path: nested });
		assert.deepEqual(calls, [["workspace", "add", nested]]);
		assert.equal(existsSync(join(temporary, "a", "b")), true);
		assert.equal(existsSync(nested), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("addJjWorkspace and forgetJjWorkspaces emit argv-only mutations", async () => {
	const calls: string[][] = [];
	const pi = {
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return execResult();
		},
	};
	await addJjWorkspace(pi, "/repo", { path: "/tmp/w", name: "feat" });
	await addJjWorkspace(pi, "/repo", { path: "/tmp/w2", startCommit: oid });
	await forgetJjWorkspaces(pi, "/repo", ["feat", "old"]);
	assert.deepEqual(calls, [
		["workspace", "add", "/tmp/w", "--name", "feat"],
		["workspace", "add", "/tmp/w2", "-r", oid],
		["workspace", "forget", "--ignore-working-copy", "feat", "old"],
	]);
});

test("jj failures outside a repository and missing executables produce helpful errors", async () => {
	await assert.rejects(
		listJjWorkspaces(
			{
				exec: async () =>
					execResult({ stdout: "", stderr: 'Error: There is no jj repo in "."', code: 1 }),
			},
			"/tmp",
		),
		/not inside a Jujutsu repository/i,
	);
	await assert.rejects(
		currentJjWorkspaceRoot(
			{
				exec: async () => {
					const error = new Error("spawn jj ENOENT");
					throw error;
				},
			},
			"/repo",
		),
		/Jujutsu \(jj\) executable was not found/i,
	);
});
