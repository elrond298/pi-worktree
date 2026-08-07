import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createWorktreeSettingsRuntime, type WorktreeSettingsRuntime } from "../src/settings.js";
import worktreeExtension from "../src/worktree.js";
import { createMockContext, createMockPi } from "./support.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

interface JjFixtureRecord {
	name: string;
	path: string;
	staleRoot?: boolean;
	changeId?: string;
	commitId?: string;
	empty?: boolean;
	conflict?: boolean;
	abandoned?: boolean;
}

function jjLine(record: JjFixtureRecord): string {
	return [
		record.name,
		record.staleRoot
			? "<Error: Failed to resolve workspace root: no such file or directory>"
			: record.path,
		record.changeId ?? "kkmpptxz",
		record.commitId ?? oid.slice(0, 12),
		record.empty === false ? "dirty" : "empty",
		record.conflict ? "conflict" : "ok",
		record.abandoned ? "abandoned" : "visible",
		"",
	].join("\0");
}

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function fixturePi(
	main: string,
	workspaces: JjFixtureRecord[],
	options: { settings?: WorktreeSettingsRuntime } = {},
): { mock: ReturnType<typeof createMockPi>; adds: string[][]; forgets: string[][] } {
	const mock = createMockPi();
	const adds: string[][] = [];
	const forgets: string[][] = [];
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "workspace" && args[1] === "list") {
			return result(`${workspaces.map(jjLine).join("\n")}\n`);
		}
		if (args[0] === "workspace" && args[1] === "root") return result(`${main}\n`);
		if (args[0] === "workspace" && args[1] === "add") {
			adds.push(args);
			const path = args[2] ?? "";
			const nameIndex = args.indexOf("--name");
			const name = nameIndex >= 0 ? (args[nameIndex + 1] ?? "") : (path.split("/").at(-1) ?? "");
			workspaces.push({ name, path });
			return result();
		}
		if (args[0] === "workspace" && args[1] === "forget") {
			forgets.push(args);
			for (const name of args.slice(3)) {
				const index = workspaces.findIndex((record) => record.name === name);
				if (index >= 0) workspaces.splice(index, 1);
			}
			return result();
		}
		if (args[0] === "log") return result(`${oid}\n`);
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi, options.settings ? { settings: options.settings } : {});
	return { mock, adds, forgets };
}

function jjWorkspaceRoot(main: string): void {
	mkdirSync(join(main, ".jj", "repo"), { recursive: true });
}

test("/worktree dispatches to the jj menu inside a jj workspace and lists jj actions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-menu-"));
	const main = join(root, "repo");
	jjWorkspaceRoot(main);
	const { mock } = fixturePi(main, [{ name: "default", path: main }]);
	try {
		const menuTitles: string[] = [];
		let actions: string[] = [];
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async (title: string, items: string[]) => {
				menuTitles.push(title);
				actions = items;
				return undefined;
			},
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(actions, [
			"Add workspace",
			"Switch workspace",
			"Remove workspace",
			"Prune stale workspaces",
			"Configure workspace root",
		]);
		assert.ok(menuTitles.some((title) => /Jj workspaces/.test(title)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj add creates a named workspace from a start point with safe argv and verifies it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-add-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	const { mock, adds } = fixturePi(main, [{ name: "default", path: main }]);
	try {
		const inputs = ["feat-login", "main", linked];
		const confirms = [true, false];
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add workspace",
			input: async () => inputs.shift(),
			confirm: async () => confirms.shift() ?? false,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(adds, [["workspace", "add", linked, "--name", "feat-login", "-r", oid]]);
		assert.match(context.notifications.at(-1)?.message ?? "", /Created jj workspace feat-login/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj add with a blank name and start point derives the name and skips both flags", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-add-plain-"));
	const main = join(root, "repo");
	const linked = join(root, "plain-workspace");
	jjWorkspaceRoot(main);
	const { mock, adds } = fixturePi(main, [{ name: "default", path: main }]);
	try {
		const inputs = ["", "", linked];
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add workspace",
			input: async () => inputs.shift(),
			confirm: async () => true,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(adds, [["workspace", "add", linked]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj add refuses an existing workspace name before any mutation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-add-refuse-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	mkdirSync(linked);
	const { mock, adds } = fixturePi(main, [
		{ name: "default", path: main },
		{ name: "taken", path: linked },
	]);
	try {
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add workspace",
			input: async () => "taken",
			confirm: async () => true,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(adds, []);
		assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj add refuses an existing target path before any mutation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-add-path-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	mkdirSync(linked);
	const { mock, adds } = fixturePi(main, [
		{ name: "default", path: main },
		{ name: "other", path: join(root, "elsewhere") },
	]);
	try {
		const inputs = ["fresh", "", linked];
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add workspace",
			input: async () => inputs.shift(),
			confirm: async () => true,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(adds, []);
		assert.match(context.notifications.at(-1)?.message ?? "", /already exists/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj remove forgets only a confirmed clean non-current non-main workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-remove-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	mkdirSync(linked);
	const workspaces: JjFixtureRecord[] = [
		{ name: "default", path: main },
		{ name: "feature", path: linked },
	];
	const { mock, forgets } = fixturePi(main, workspaces);
	try {
		let selectCount = 0;
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async (_title: string, items: string[]) =>
				selectCount++ === 0 ? "Remove workspace" : items[0],
			confirm: async () => true,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(forgets, [["workspace", "forget", "--ignore-working-copy", "feature"]]);
		assert.match(context.notifications.at(-1)?.message ?? "", /Removed jj workspace feature/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj remove excludes dirty, abandoned, conflicted, current, and main workspaces", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-remove-exclude-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	mkdirSync(linked);
	const workspaces: JjFixtureRecord[] = [
		{ name: "default", path: main },
		{ name: "dirty", path: join(root, "dirty"), empty: false },
		{ name: "abandoned", path: join(root, "abandoned"), abandoned: true },
		{ name: "conflicted", path: join(root, "conflicted"), conflict: true },
		{ name: "healthy", path: linked },
	];
	const { mock, forgets } = fixturePi(main, workspaces);
	try {
		const notices: string[] = [];
		let selectCount = 0;
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async (title: string, items: string[]) => {
				notices.push(`${title}:${items.join("|")}`);
				selectCount += 1;
				return selectCount === 1 ? "Remove workspace" : undefined;
			},
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(forgets, []);
		assert.ok(notices.some((notice) => /1\. .*repo-feature/.test(notice)));
		assert.ok(notices.every((notice) => !/dirty|abandoned|conflicted/.test(notice)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj prune previews stale workspaces, confirms, and forgets them together", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-prune-"));
	const main = join(root, "repo");
	jjWorkspaceRoot(main);
	const workspaces: JjFixtureRecord[] = [
		{ name: "default", path: main },
		{ name: "gone", path: join(root, "gone"), staleRoot: true },
		{ name: "orphan", path: join(root, "orphan"), abandoned: true },
	];
	const { mock, forgets } = fixturePi(main, workspaces);
	try {
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Prune stale workspaces",
			confirm: async () => true,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.ok(
			context.notifications.some(
				(notice) =>
					notice.level === "warning" && /jj workspace forget preview/.test(notice.message),
			),
		);
		assert.deepEqual(forgets, [["workspace", "forget", "--ignore-working-copy", "gone", "orphan"]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj prune refuses stale workspaces with uncommitted or conflicted working copies", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-prune-blocked-"));
	const main = join(root, "repo");
	jjWorkspaceRoot(main);
	const workspaces: JjFixtureRecord[] = [
		{ name: "default", path: main },
		{ name: "gone-dirty", path: join(root, "gone-dirty"), staleRoot: true, empty: false },
		{ name: "gone-conflict", path: join(root, "gone-conflict"), staleRoot: true, conflict: true },
	];
	const { mock, forgets } = fixturePi(main, workspaces);
	try {
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Prune stale workspaces",
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(forgets, []);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/Prune refused because gone-dirty, gone-conflict/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj prune reports when no stale workspaces exist", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-prune-clean-"));
	const main = join(root, "repo");
	jjWorkspaceRoot(main);
	const { mock, forgets } = fixturePi(main, [{ name: "default", path: main }]);
	try {
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Prune stale workspaces",
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(forgets, []);
		assert.match(context.notifications.at(-1)?.message ?? "", /no stale workspaces/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj switch selects an existing workspace and switches the Pi session to it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-switch-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	jjWorkspaceRoot(main);
	mkdirSync(linked);
	const { mock } = fixturePi(main, [
		{ name: "default", path: main },
		{ name: "feature", path: linked },
	]);
	try {
		let selectCount = 0;
		let switchedCwd = "";
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
			select: async (_title: string, items: string[]) =>
				selectCount++ === 0 ? "Switch workspace" : items[0],
			switchSession: async (path: string) => {
				const { SessionManager } = await import("@earendil-works/pi-coding-agent");
				switchedCwd = SessionManager.open(path).getCwd();
				return { cancelled: false };
			},
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(switchedCwd, linked);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("jj mode configures the workspace root through the shared settings flow", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-jj-configure-"));
	const main = join(root, "repo");
	const settingsPath = join(root, "agent", "pi-worktree.json");
	jjWorkspaceRoot(main);
	const settings = createWorktreeSettingsRuntime({
		path: settingsPath,
		home: "/home/alice",
		platform: "linux",
	});
	const { mock } = fixturePi(main, [{ name: "default", path: main }], { settings });
	try {
		const { readFileSync } = await import("node:fs");
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Configure workspace root",
			input: async () => "/srv/workspaces",
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			worktreeRoot: "/srv/workspaces",
		});
		assert.equal(settings.get().effectiveRoot, "/srv/workspaces");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Structural type used only to make mock assignment concise.
type ExecFunction = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
