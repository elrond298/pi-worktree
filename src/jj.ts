import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathIdentity, pathsEqual, stripTerminalControls } from "./git.js";

const JJ_TIMEOUT_MS = 15_000;
const JJ_MUTATION_TIMEOUT_MS = 60_000;
const IGNORE_WORKING_COPY = "--ignore-working-copy";

export interface JjWorkspaceRecord {
	name: string;
	/** Absolute workspace root; undefined when jj can no longer resolve the root on disk. */
	path?: string;
	changeId: string;
	commitId: string;
	/** True when the working copy commit has no diff against its parents. */
	empty: boolean;
	conflict: boolean;
	/** True when the working copy commit was abandoned (hidden). */
	abandoned: boolean;
	description: string;
}

export interface JjAddArguments {
	path: string;
	name?: string;
	startCommit?: string;
}

export class JjWorkspaceError extends Error {
	readonly args?: readonly string[];

	constructor(message: string, args?: readonly string[]) {
		super(message);
		this.name = "JjWorkspaceError";
		this.args = args;
	}
}

const WORKSPACE_LIST_TEMPLATE =
	[
		"name",
		"root",
		"target.change_id().short()",
		"target.commit_id().short()",
		'if(target.empty(), "empty", "dirty")',
		'if(target.conflict(), "conflict", "ok")',
		'if(target.hidden(), "abandoned", "visible")',
		"target.description().first_line()",
	].join(' ++ "\\0" ++ ') + ' ++ "\\n"';

/**
 * Determines whether the current Pi cwd is managed by Jujutsu or Git.
 * A `.jj` entry in any ancestor marks a Jujutsu workspace; colocated
 * repositories therefore resolve to jj, which owns their workspaces.
 */
export function detectVcs(cwd: string): "jj" | "git" {
	return findJjWorkspaceRoot(cwd) === undefined ? "git" : "jj";
}

/**
 * Walks ancestors of `cwd` for the closest `.jj` entry, mirroring jj's own
 * repository detection. Returns the workspace root or undefined.
 */
export function findJjWorkspaceRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		try {
			const stat = lstatSync(resolve(current, ".jj"));
			if (stat.isDirectory() || stat.isFile()) return current;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") {
				throw new JjWorkspaceError(
					`Cannot inspect jj workspace ancestor ${current}: ${formatError(error)}`,
				);
			}
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Returns the root of the workspace that contains the jj repository (the jj
 * analogue of Git's main worktree), or undefined when the current cwd is not
 * inside a jj workspace.
 */
export function jjRepoRoot(cwd: string): string | undefined {
	const workspaceRoot = findJjWorkspaceRoot(cwd);
	if (workspaceRoot === undefined) return undefined;
	const repoPointer = resolve(workspaceRoot, ".jj", "repo");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(repoPointer);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new JjWorkspaceError("The jj workspace is missing its .jj/repo entry.");
		}
		throw new JjWorkspaceError(
			`Cannot inspect the jj workspace .jj/repo entry: ${formatError(error)}`,
		);
	}
	if (stat.isDirectory()) return workspaceRoot;
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new JjWorkspaceError("The jj workspace .jj/repo entry has an unexpected type.");
	}
	const pointer = removeLineEnding(readFileSync(repoPointer, "utf8"));
	if (!pointer) throw new JjWorkspaceError("The jj workspace .jj/repo pointer is empty.");
	const repositoryDirectory = resolve(workspaceRoot, pointer);
	return dirname(dirname(repositoryDirectory));
}

export function parseJjWorkspaceList(output: string): JjWorkspaceRecord[] {
	const records: JjWorkspaceRecord[] = [];
	for (const line of output.split("\n")) {
		if (line === "") continue;
		const fields = line.split("\0");
		if (fields.length !== 8) {
			throw new JjWorkspaceError("jj returned malformed workspace list output.");
		}
		const [name, root, changeId, commitId, empty, conflict, hidden, description] = fields;
		if (!name || !changeId || !commitId) {
			throw new JjWorkspaceError("jj returned a workspace record with missing identity fields.");
		}
		if (!/^[0-9a-z]+$/u.test(changeId) || !/^[0-9a-fA-F]+$/u.test(commitId)) {
			throw new JjWorkspaceError(
				"jj returned a workspace record with malformed commit identifiers.",
			);
		}
		if (empty !== "empty" && empty !== "dirty") {
			throw new JjWorkspaceError("jj returned an unexpected working copy state token.");
		}
		if (conflict !== "conflict" && conflict !== "ok") {
			throw new JjWorkspaceError("jj returned an unexpected conflict state token.");
		}
		if (hidden !== "abandoned" && hidden !== "visible") {
			throw new JjWorkspaceError("jj returned an unexpected working copy visibility token.");
		}
		// jj renders `<Error: ...>` in place of root() when the workspace
		// directory no longer exists; such records have no resolvable path.
		const path = root !== "" && isAbsolute(root) ? pathIdentity(root) : undefined;
		records.push({
			name,
			...(path === undefined ? {} : { path }),
			changeId,
			commitId,
			empty: empty === "empty",
			conflict: conflict === "conflict",
			abandoned: hidden === "abandoned",
			description,
		});
	}
	return records;
}

export async function listJjWorkspaces(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<JjWorkspaceRecord[]> {
	const result = await runJj(
		pi,
		["workspace", "list", IGNORE_WORKING_COPY, "-T", WORKSPACE_LIST_TEMPLATE],
		cwd,
		signal,
	);
	return parseJjWorkspaceList(result.stdout);
}

export async function currentJjWorkspaceRoot(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runJj(pi, ["workspace", "root", IGNORE_WORKING_COPY], cwd, signal);
	const path = removeLineEnding(result.stdout);
	if (!path) throw new JjWorkspaceError("jj did not return the current workspace root.");
	return pathIdentity(path);
}

/**
 * Resolves a user-supplied start point to exactly one commit id, mirroring the
 * Git flow's "the start point must resolve to exactly one commit" rule.
 */
export async function resolveJjRevision(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	revision: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runJj(
		pi,
		["log", IGNORE_WORKING_COPY, "--no-graph", "-T", 'commit_id ++ "\\n"', "-r", revision],
		cwd,
		signal,
	);
	const lines = result.stdout.split("\n").filter((line) => line.length > 0);
	if (lines.length !== 1) {
		throw new JjWorkspaceError(
			`Start point ${JSON.stringify(revision)} must resolve to exactly one commit.`,
		);
	}
	const oid = lines[0]?.trim() ?? "";
	if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
		throw new JjWorkspaceError(`jj returned an invalid commit object for ${revision}.`);
	}
	return oid;
}

export function validateJjWorkspaceName(value: string): string {
	const name = value.trim();
	if (!name) throw new JjWorkspaceError("Workspace name is required.");
	if (/[/\\\p{Cc}]/u.test(name)) {
		throw new JjWorkspaceError(
			"Workspace name must not contain path separators or control characters.",
		);
	}
	if (name === "." || name === "..") {
		throw new JjWorkspaceError("Workspace name must not be . or ..");
	}
	return name;
}

export function defaultJjWorkspacePath(
	mainWorkspaceRoot: string,
	leaf: string,
	workspaceRoot: string,
): string {
	return resolve(workspaceRoot, basename(mainWorkspaceRoot), leaf);
}

export function buildJjAddArguments(input: JjAddArguments): string[] {
	const args = ["workspace", "add", input.path];
	if (input.name !== undefined) args.push("--name", input.name);
	if (input.startCommit !== undefined) args.push("-r", input.startCommit);
	return args;
}

export async function addJjWorkspace(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	input: JjAddArguments,
	signal?: AbortSignal,
): Promise<void> {
	ensureParentDirectory(input.path);
	await runJj(pi, buildJjAddArguments(input), cwd, signal, JJ_MUTATION_TIMEOUT_MS);
}

/**
 * Unlike `git worktree add`, `jj workspace add` requires the destination's
 * parent directory to already exist and fails with "Cannot access" otherwise.
 * Create the parent chain so the default ~/.worktrees/<project>/<name>
 * suggestions work on first use, matching Git's implicit directory creation.
 */
function ensureParentDirectory(targetPath: string): void {
	try {
		mkdirSync(dirname(targetPath), { recursive: true });
	} catch (error) {
		throw new JjWorkspaceError(
			`Cannot create the parent directory of the new workspace: ${formatError(error)}`,
		);
	}
}

export async function forgetJjWorkspaces(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	names: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	if (names.length === 0) return;
	await runJj(
		pi,
		["workspace", "forget", IGNORE_WORKING_COPY, ...names],
		cwd,
		signal,
		JJ_MUTATION_TIMEOUT_MS,
	);
}

export function formatJjWorkspace(
	record: JjWorkspaceRecord,
	currentPath?: string,
	mainRoot?: string,
): string {
	const labels = [
		currentPath && record.path !== undefined && pathsEqual(record.path, currentPath)
			? "current"
			: undefined,
		mainRoot && record.path !== undefined && pathsEqual(record.path, mainRoot) ? "main" : undefined,
		record.path === undefined ? "prunable: root missing" : undefined,
		record.abandoned ? "prunable: working copy abandoned" : undefined,
		record.conflict ? "conflict" : undefined,
		!record.empty ? "dirty" : undefined,
	].filter((label): label is string => label !== undefined);
	const location = record.path ?? record.name;
	const head = record.changeId.slice(0, 8);
	return stripTerminalControls(`${location}  [${labels.join(", ") || "unknown"}]  ${head}`);
}

export function sameJjWorkspaceIdentity(
	left: JjWorkspaceRecord,
	right: JjWorkspaceRecord,
): boolean {
	return (
		left.name === right.name &&
		((left.path === undefined && right.path === undefined) ||
			(left.path !== undefined && right.path !== undefined && pathsEqual(left.path, right.path))) &&
		left.changeId === right.changeId &&
		left.commitId === right.commitId &&
		left.empty === right.empty &&
		left.conflict === right.conflict &&
		left.abandoned === right.abandoned
	);
}

async function runJj(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = JJ_TIMEOUT_MS,
): Promise<ExecResult> {
	const result = await runJjAllowFailure(pi, args, cwd, signal, timeout);
	if (result.killed) {
		throw new JjWorkspaceError(
			`jj ${args.slice(0, 2).join(" ")} timed out or was cancelled.`,
			args,
		);
	}
	if (result.code !== 0) throw jjFailure(args, result);
	return result;
}

async function runJjAllowFailure(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = JJ_TIMEOUT_MS,
): Promise<ExecResult> {
	try {
		return await pi.exec("jj", args, { cwd, signal, timeout });
	} catch (error) {
		const message = formatError(error);
		if (/\bENOENT\b|not found/i.test(message)) {
			throw new JjWorkspaceError(
				"Jujutsu (jj) executable was not found. Install jj and retry.",
				args,
			);
		}
		throw new JjWorkspaceError(
			`Could not start jj ${args.slice(0, 2).join(" ")}: ${message}`,
			args,
		);
	}
}

function jjFailure(args: string[], result: ExecResult): JjWorkspaceError {
	const detail = stripTerminalControls(
		[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"),
	);
	const hint = /no jj repo/i.test(detail)
		? "The current Pi workspace is not inside a Jujutsu repository."
		: detail || `jj exited with code ${result.code}.`;
	return new JjWorkspaceError(`jj ${args.slice(0, 2).join(" ")} failed: ${hint}`, args);
}

function removeLineEnding(value: string): string {
	if (value.endsWith("\r\n")) return value.slice(0, -2);
	if (value.endsWith("\n")) return value.slice(0, -1);
	return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
