import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	addWorktree,
	administrativeHistoryOids,
	administrativePruneCandidates,
	currentWorktreePath,
	defaultWorktreePath,
	durableRefExists,
	durableRefsContaining,
	formatWorktree,
	listWorktrees,
	localBranchExists,
	pathEntryExists,
	pathIdentity,
	pathsEqual,
	prunePreview,
	pruneWorktrees,
	removeWorktree,
	resolveCommit,
	sameWorktreeIdentity,
	stripTerminalControls,
	symbolicBranch,
	unresolvableSymlinkAncestor,
	validateBranch,
	type WorktreeRecord,
	worktreeAdministrativeDirectory,
	worktreeForBranch,
	worktreeInventory,
} from "./git.js";
import {
	addJjWorkspace,
	currentJjWorkspaceRoot,
	defaultJjWorkspacePath,
	detectVcs,
	forgetJjWorkspaces,
	formatJjWorkspace,
	type JjWorkspaceRecord,
	jjRepoRoot,
	listJjWorkspaces,
	resolveJjRevision,
	sameJjWorkspaceIdentity,
	validateJjWorkspaceName,
} from "./jj.js";
import { switchToWorktree } from "./session.js";
import type { WorktreeSettingsRuntime } from "./settings.js";
import { loadWorktreeStatusCards, type WorktreeStatusCard } from "./status.js";

const ACTION_STATUS = "Worktree status";
const ACTION_ADD = "Add worktree";
const ACTION_SWITCH = "Switch worktree";
const ACTION_REMOVE = "Remove worktree";
const ACTION_PRUNE = "Prune stale metadata";
const ACTION_CONFIGURE_ROOT = "Configure worktree root";
const ACTIONS = {
	status: ACTION_STATUS,
	add: ACTION_ADD,
	switch: ACTION_SWITCH,
	remove: ACTION_REMOVE,
	prune: ACTION_PRUNE,
	configure: ACTION_CONFIGURE_ROOT,
} as const;

const JJ_MENU_ACTION_LABELS = {
	add: "Add workspace",
	switch: "Switch workspace",
	remove: "Remove workspace",
	prune: "Prune stale workspaces",
	configure: "Configure workspace root",
} as const;

interface WorktreeMenuState {
	statusCards: WorktreeStatusCard[];
}

interface WorktreeMenuOwner {
	signal: AbortSignal;
	isCurrent(): boolean;
}

interface AdministrativeHistoryRisk {
	label: string;
	oids: string[];
}

interface AddBaseProvenance {
	kind: "existing-local-branch" | "current-branch" | "explicit-commit-ish";
	label: string;
	oid: string;
}

export function registerWorktreeCommand(
	pi: ExtensionAPI,
	settings: WorktreeSettingsRuntime,
	getMenuOwner: () => WorktreeMenuOwner,
): void {
	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (args.trim()) {
			safeNotify(
				ctx,
				"/worktree does not accept arguments; run it without arguments to open the menu.",
				"warning",
			);
			return;
		}
		if (!ctx.hasUI) {
			safeNotify(ctx, "/worktree requires TUI or RPC mode.", "error");
			return;
		}

		try {
			if (detectVcs(ctx.cwd) === "jj") {
				await jjMenuFlow(pi, ctx, settings, getMenuOwner);
				return;
			}
			await gitMenuFlow(pi, ctx, settings, getMenuOwner);
		} catch (error) {
			safeNotify(ctx, formatError(error), "error");
		}
	};
	pi.registerCommand("worktree", {
		description: "Interactively manage Git worktrees and Jujutsu workspaces and their default root",
		handler,
	});
	pi.registerCommand("workspace", {
		description:
			"Alias for /worktree: interactively manage Git worktrees and Jujutsu workspaces and their default root",
		handler,
	});
}

async function gitMenuFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: WorktreeSettingsRuntime,
	getMenuOwner: () => WorktreeMenuOwner,
): Promise<void> {
	await ctx.waitForIdle();
	const records = await listWorktrees(pi, ctx.cwd, ctx.signal);
	const currentPath = await currentWorktreePath(pi, ctx.cwd, ctx.signal);
	const root = settings.get();
	const warning = root.warning ? " — settings warning" : "";
	const owner = getMenuOwner();
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (owner.signal.aborted || !owner.isCurrent()) return;
	const runFlow = async (flow: () => Promise<void>) => {
		try {
			await flow();
		} catch (error) {
			safeNotify(ctx, formatError(error), "error");
		}
		return { kind: "close" } as const;
	};
	const state: WorktreeMenuState = { statusCards: [] };
	type Screen = "main" | "status";
	type Action = keyof typeof ACTIONS;
	const menu = defineMenu<WorktreeMenuState, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Git worktrees",
				lines: [
					`Registered: ${records.length}`,
					`Current: ${currentPath}`,
					`Worktree root: ${root.effectiveRoot} (${root.source})${warning}`,
				],
				items: Object.entries(ACTIONS).map(([id, label]) => ({
					id,
					label,
					action: id as Action,
					busyLabel: id === "status" ? "Inspecting worktrees…" : undefined,
				})),
				hint: "close",
			}),
			status: ({ state: currentState }) => ({
				kind: "browse",
				title: "Worktree status",
				lines: ["Local Git snapshot; no fetch performed."],
				items: currentState.statusCards,
				viewportSize: "adaptive",
				hint: "back",
			}),
		},
		actions: {
			status: async ({ signal }) => {
				try {
					const statusRecords = await listWorktrees(pi, ctx.cwd, signal);
					state.statusCards = await loadWorktreeStatusCards(pi, statusRecords, currentPath, signal);
					if (signal.aborted || !owner.isCurrent()) return { kind: "close" };
					return { kind: "to", screen: "status" };
				} catch (error) {
					if (signal.aborted || !owner.isCurrent()) return { kind: "close" };
					safeNotify(ctx, formatError(error), "error");
					return { kind: "stay" };
				}
			},
			add: async () => runFlow(() => addFlow(pi, ctx, records, root.effectiveRoot)),
			switch: async ({ signal }) =>
				runFlow(() => switchFlow(pi, ctx, records, currentPath, signal)),
			remove: async ({ signal }) =>
				runFlow(() => removeFlow(pi, ctx, records, currentPath, signal)),
			prune: async () => runFlow(() => pruneFlow(pi, ctx, records)),
			configure: async () => runFlow(() => configureRootFlow(ctx, settings, "Worktree root")),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => state,
		signal: owner.signal,
		isCurrent: owner.isCurrent,
	});
}

async function jjMenuFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: WorktreeSettingsRuntime,
	getMenuOwner: () => WorktreeMenuOwner,
): Promise<void> {
	await ctx.waitForIdle();
	const records = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
	const currentPath = await currentJjWorkspaceRoot(pi, ctx.cwd, ctx.signal);
	const mainRoot = jjRepoRoot(ctx.cwd);
	const root = settings.get();
	const warning = root.warning ? " — settings warning" : "";
	const owner = getMenuOwner();
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (owner.signal.aborted || !owner.isCurrent()) return;
	const runFlow = async (flow: () => Promise<void>) => {
		try {
			await flow();
		} catch (error) {
			safeNotify(ctx, formatError(error), "error");
		}
		return { kind: "close" } as const;
	};
	type Screen = "main";
	type Action = keyof typeof JJ_MENU_ACTION_LABELS;
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Jj workspaces",
				lines: [
					`Registered: ${records.length}`,
					`Current: ${currentPath}`,
					`Workspace root: ${root.effectiveRoot} (${root.source})${warning}`,
				],
				items: Object.entries(JJ_MENU_ACTION_LABELS).map(([id, label]) => ({
					id,
					label,
					action: id as Action,
				})),
				hint: "close",
			}),
		},
		actions: {
			add: async () =>
				runFlow(() => jjAddFlow(pi, ctx, records, root.effectiveRoot, currentPath, mainRoot)),
			switch: async ({ signal }) =>
				runFlow(() => jjSwitchFlow(pi, ctx, records, currentPath, signal)),
			remove: async ({ signal }) =>
				runFlow(() => jjRemoveFlow(pi, ctx, records, currentPath, mainRoot, signal)),
			prune: async () => runFlow(() => jjPruneFlow(pi, ctx)),
			configure: async () => runFlow(() => configureRootFlow(ctx, settings, "Workspace root")),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.signal,
		isCurrent: owner.isCurrent,
	});
}

async function configureRootFlow(
	ctx: ExtensionCommandContext,
	settings: WorktreeSettingsRuntime,
	settingsLabel: string,
): Promise<void> {
	const current = await settings.reload();
	if (!current.canSave) {
		throw new Error(
			current.warning ?? `Fix ${settings.getPath()} before changing pi-worktree settings.`,
		);
	}
	const requested = await ctx.ui.input(
		`${settingsLabel} (blank restores ~/.worktrees)`,
		stripTerminalControls(current.configuredRoot ?? current.effectiveRoot),
	);
	if (requested === undefined) return;
	const configuredRoot = requested.trim() || undefined;
	const updated = await settings.save(configuredRoot);
	safeNotify(
		ctx,
		configuredRoot === undefined
			? `Worktree root reset to ${updated.effectiveRoot}.`
			: `Worktree root saved as ${updated.effectiveRoot}.`,
		"info",
	);
}

async function addFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	worktreeRoot: string,
): Promise<void> {
	const main = records[0];
	if (!main) throw new Error("Git returned no registered worktrees.");
	if (main.bare) {
		throw new Error("The main worktree is bare; pi-worktree cannot derive a safe default path.");
	}
	if (!existsSync(main.path)) {
		throw new Error(
			`The registered main worktree path is stale: ${main.path}. Repair it with Git first.`,
		);
	}

	const requestedBranch = await ctx.ui.input("Branch for the new worktree", "feat/my-change");
	if (requestedBranch === undefined) return;
	const branchInput = requestedBranch.trim();
	if (!branchInput) throw new Error("Branch name is required.");
	const branch = await validateBranch(pi, ctx.cwd, branchInput, ctx.signal);
	const branchExists = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
	const occupied = worktreeForBranch(records, branch);
	if (occupied) {
		throw new Error(`Branch ${branch} is already checked out at ${occupied.path}.`);
	}

	let startOid: string | undefined;
	let provenance: AddBaseProvenance;
	if (branchExists) {
		provenance = {
			kind: "existing-local-branch",
			label: branch,
			oid: await resolveCommit(pi, ctx.cwd, `refs/heads/${branch}`, ctx.signal),
		};
	} else {
		const defaultStart = await symbolicBranch(pi, ctx.cwd, ctx.signal);
		const requestedStart = await ctx.ui.input(
			stripTerminalControls(
				defaultStart
					? `Start point for ${branch} (blank uses ${defaultStart})`
					: `Start point for ${branch} (required because HEAD is detached)`,
			),
			stripTerminalControls(defaultStart ?? "commit-ish"),
		);
		if (requestedStart === undefined) return;
		const explicitStart = requestedStart.trim();
		const startLabel = explicitStart || defaultStart;
		if (!startLabel) throw new Error("An explicit start point is required from detached HEAD.");
		startOid = await resolveCommit(pi, ctx.cwd, startLabel, ctx.signal);
		provenance = {
			kind: explicitStart ? "explicit-commit-ish" : "current-branch",
			label: startLabel,
			oid: startOid,
		};
	}

	const suggestedPath = defaultWorktreePath(main.path, branch, worktreeRoot);
	const requestedPath = await ctx.ui.input(
		stripTerminalControls(`Worktree path (blank uses ${suggestedPath})`),
		stripTerminalControls(suggestedPath),
	);
	if (requestedPath === undefined) return;
	const targetPath = pathIdentity(
		requestedPath.trim() ? resolve(ctx.cwd, requestedPath.trim()) : suggestedPath,
	);
	assertTargetFilesystemAvailable(targetPath);
	const pathCollision = records.find((record) => pathsEqual(record.path, targetPath));
	if (pathCollision) {
		throw new Error(`The target path is already registered as a worktree: ${pathCollision.path}.`);
	}

	const summary = formatAddPreview(branch, branchExists, provenance, targetPath);
	if (!(await ctx.ui.confirm("Create Git worktree", summary))) return;

	assertTargetFilesystemAvailable(targetPath);
	const latestRecords = await listWorktrees(pi, ctx.cwd, ctx.signal);
	const latestOccupied = worktreeForBranch(latestRecords, branch);
	if (latestOccupied) {
		throw new Error(
			`Branch ${branch} is now checked out at ${latestOccupied.path}; select it again.`,
		);
	}
	const latestPathCollision = latestRecords.find((record) => pathsEqual(record.path, targetPath));
	if (latestPathCollision) {
		throw new Error(
			`The target path is now registered as a worktree: ${latestPathCollision.path}. Select it again.`,
		);
	}
	const branchStillExists = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
	if (branchStillExists !== branchExists) {
		throw new Error(`Branch ${branch} changed after confirmation; select it again.`);
	}
	if (branchExists) {
		const latestOid = await resolveCommit(pi, ctx.cwd, `refs/heads/${branch}`, ctx.signal);
		if (latestOid !== provenance.oid) {
			throw new Error(`Branch ${branch} moved after confirmation; select it again.`);
		}
	}

	assertTargetFilesystemAvailable(targetPath);
	await addWorktree(pi, ctx.cwd, { path: targetPath, branch, startOid }, ctx.signal);
	let created: WorktreeRecord;
	try {
		const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
		const verified = updated.find((record) => pathsEqual(record.path, targetPath));
		if (!verified || verified.branch !== branch || verified.head !== provenance.oid) {
			throw new Error(
				"the expected path, branch, and approved HEAD were not present in Git porcelain output",
			);
		}
		created = verified;
	} catch (error) {
		throw new Error(
			`Git add completed, so the worktree was retained at ${targetPath}, but verification failed: ${formatError(error)}. Inspect git worktree list before retrying.`,
		);
	}
	safeNotify(ctx, `Created worktree ${targetPath} on branch ${branch}.`, "info");

	if (
		await ctx.ui.confirm(
			"Switch Pi workspace?",
			stripTerminalControls(`Continue this conversation in ${targetPath}?`),
		)
	) {
		const latest = await revalidateWorktreeIdentity(pi, ctx, created);
		if (latest.prunableReason !== undefined || !existsSync(latest.path)) {
			throw new Error("The newly created worktree became unavailable; select it again.");
		}
		await switchToWorktree(ctx, latest.path);
	}
}

function formatAddPreview(
	branch: string,
	branchExists: boolean,
	provenance: AddBaseProvenance,
	targetPath: string,
): string {
	const base =
		provenance.kind === "existing-local-branch"
			? `existing local branch ${quoteTerminalValue(provenance.label)}`
			: provenance.kind === "current-branch"
				? `current branch ${quoteTerminalValue(provenance.label)}`
				: `explicit commit-ish ${quoteTerminalValue(provenance.label)}`;
	return [
		`Branch: ${quoteTerminalValue(branch)} (${branchExists ? "existing" : "new"} local branch)`,
		`Base: ${base}`,
		`Base commit: ${provenance.oid}`,
		`Path: ${quoteTerminalValue(targetPath)}`,
	].join("; ");
}

function quoteTerminalValue(value: string): string {
	let quoted = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			quoted += `\\u${code.toString(16).padStart(4, "0")}`;
		} else if (character === "\\" || character === '"') {
			quoted += `\\${character}`;
		} else {
			quoted += character;
		}
	}
	return `"${quoted}"`;
}

function assertTargetFilesystemAvailable(targetPath: string): void {
	if (pathEntryExists(targetPath)) {
		throw new Error(`The target path already exists: ${targetPath}.`);
	}
	const unsafeAncestor = unresolvableSymlinkAncestor(targetPath);
	if (unsafeAncestor) {
		throw new Error(
			`The target path has an unresolvable symbolic-link ancestor: ${unsafeAncestor}.`,
		);
	}
}

async function switchFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	currentPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const candidates = records.filter(
		(record) =>
			!record.bare &&
			record.prunableReason === undefined &&
			existsSync(record.path) &&
			!pathsEqual(record.path, currentPath),
	);
	const selected = await selectWorktree(ctx, "Switch to worktree", candidates, currentPath, signal);
	if (!selected) return;
	const latest = await revalidateWorktreeIdentity(pi, ctx, selected);
	if (
		latest.bare ||
		latest.prunableReason !== undefined ||
		!existsSync(latest.path) ||
		pathsEqual(latest.path, currentPath)
	) {
		throw new Error("The selected worktree changed state; select it again.");
	}
	await switchToWorktree(ctx, latest.path);
}

async function removeFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
	currentPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const candidates = records.filter(
		(record) => !record.isMain && !record.bare && !pathsEqual(record.path, currentPath),
	);
	const selected = await selectWorktree(
		ctx,
		"Remove linked worktree",
		candidates,
		currentPath,
		signal,
	);
	if (!selected) return;
	if (selected.lockedReason !== undefined) {
		throw new Error(
			`Worktree is locked${selected.lockedReason ? `: ${selected.lockedReason}` : "."} Unlock it explicitly with Git before removal.`,
		);
	}
	if (selected.prunableReason !== undefined || !existsSync(selected.path)) {
		throw new Error("The selected worktree path is stale. Use prune instead of remove.");
	}

	const inventory = classifyRemovalInventory(
		await worktreeInventory(pi, selected.path, ctx.signal),
	);
	if (inventory.protected.length > 0) {
		throw new Error(
			`Removal refused because ${selected.path} contains tracked, untracked, index-flagged, or submodule data:\n${inventory.protected.join("\n")}`,
		);
	}
	await assertDetachedHeadIsDurable(pi, ctx, selected);
	const administrativePath = await worktreeAdministrativeDirectory(pi, selected.path, ctx.signal);
	const approvedHistoryRisks = historyRisks(
		selected.path,
		await unreachableAdministrativeHistoryOids(pi, ctx, administrativePath),
	);
	const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
	const ignoredWarning = formatIgnoredDataWarning(inventory.ignored);
	const removalWarning =
		ignoredWarning && recoveryWarning
			? `${ignoredWarning}\n${recoveryWarning.trimStart()}`
			: `${ignoredWarning}${recoveryWarning}`;
	const confirmationTitle =
		inventory.ignored.length > 0
			? recoveryWarning
				? "Remove worktree and discard local/recovery data"
				: "Remove worktree and delete ignored files"
			: recoveryWarning
				? "Remove worktree and discard recovery history"
				: "Remove Git worktree";
	if (
		!(await ctx.ui.confirm(
			confirmationTitle,
			`Delete the worktree directory ${stripTerminalControls(selected.path)}? The branch will be preserved.${removalWarning}`,
		))
	) {
		return;
	}

	await assertAdministrativeHistoryUnchanged(
		pi,
		ctx,
		selected.path,
		administrativePath,
		approvedHistoryRisks,
	);

	const beforeRemoval = await listWorktrees(pi, ctx.cwd, ctx.signal);
	const latest = beforeRemoval.find((record) => pathsEqual(record.path, selected.path));
	if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
	if (!sameWorktreeIdentity(selected, latest)) {
		throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
	}
	if (latest.isMain || latest.lockedReason !== undefined || latest.prunableReason !== undefined) {
		throw new Error(
			`Worktree ${selected.path} changed state after confirmation; removal was refused.`,
		);
	}
	const latestInventory = classifyRemovalInventory(
		await worktreeInventory(pi, latest.path, ctx.signal),
	);
	if (latestInventory.protected.length > 0) {
		throw new Error(
			`Removal refused because new protected local data appeared after confirmation:\n${latestInventory.protected.join("\n")}`,
		);
	}
	if (!sameInventory(inventory.ignored, latestInventory.ignored)) {
		throw new Error(
			`Removal refused because ignored data changed after confirmation:\n${latestInventory.ignored.join("\n") || "(none)"}`,
		);
	}
	await assertDetachedHeadIsDurable(pi, ctx, latest);
	await assertAdministrativeHistoryUnchanged(
		pi,
		ctx,
		latest.path,
		administrativePath,
		approvedHistoryRisks,
	);
	await removeWorktree(pi, ctx.cwd, latest.path, ctx.signal);
	const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
	if (updated.some((record) => pathsEqual(record.path, selected.path))) {
		throw new Error(`Git remove returned success, but ${selected.path} is still registered.`);
	}
	safeNotify(ctx, `Removed worktree ${selected.path}. Its branch was preserved.`, "info");
}

async function pruneFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly WorktreeRecord[],
): Promise<void> {
	for (const record of records.filter(
		(candidate) => candidate.prunableReason !== undefined && candidate.detached,
	)) {
		await assertDetachedHeadIsDurable(pi, ctx, record);
	}
	const preview = await prunePreview(pi, ctx.cwd, ctx.signal);
	if (!preview) {
		ctx.ui.notify("Git found no stale worktree metadata to prune.", "info");
		return;
	}
	const approvedHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
	const safePreview = stripTerminalControls(preview);
	const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
	ctx.ui.notify(`git worktree prune --dry-run --verbose\n${safePreview}`, "warning");
	if (
		!(await ctx.ui.confirm(
			recoveryWarning
				? "Prune metadata and discard recovery history"
				: "Prune stale worktree metadata",
			stripTerminalControls(`${safePreview}${recoveryWarning}`),
		))
	) {
		return;
	}
	const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
	for (const record of latest.filter(
		(candidate) => candidate.prunableReason !== undefined && candidate.detached,
	)) {
		await assertDetachedHeadIsDurable(pi, ctx, record);
	}
	const beforePreviewHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
	if (!sameAdministrativeHistoryRisks(approvedHistoryRisks, beforePreviewHistoryRisks)) {
		throw new Error("Stale worktree metadata changed after confirmation; run prune again.");
	}
	const latestPreview = await prunePreview(pi, ctx.cwd, ctx.signal);
	const finalHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
	if (
		latestPreview !== preview ||
		!sameAdministrativeHistoryRisks(approvedHistoryRisks, finalHistoryRisks)
	) {
		throw new Error("Stale worktree metadata changed after confirmation; run prune again.");
	}
	const output = await pruneWorktrees(pi, ctx.cwd, ctx.signal);
	safeNotify(
		ctx,
		output ? `Pruned stale worktree metadata:\n${output}` : "Pruned stale worktree metadata.",
		"info",
	);
}

async function jjAddFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly JjWorkspaceRecord[],
	workspaceRoot: string,
	currentPath: string,
	mainRoot: string | undefined,
): Promise<void> {
	if (records.length === 0) throw new Error("jj returned no registered workspaces.");
	const suggestionBase = mainRoot ?? currentPath;

	const requestedName = await ctx.ui.input(
		"Workspace name (blank uses the destination directory name)",
		"my-change",
	);
	if (requestedName === undefined) return;
	const nameInput = requestedName.trim();
	const name = nameInput === "" ? undefined : validateJjWorkspaceName(nameInput);
	if (name !== undefined && records.some((record) => record.name === name)) {
		throw new Error(`A workspace named ${name} already exists.`);
	}

	const requestedStart = await ctx.ui.input(
		"Start point (blank uses the parent of the current change)",
		"@-",
	);
	if (requestedStart === undefined) return;
	const startInput = requestedStart.trim();
	const startCommit =
		startInput === "" ? undefined : await resolveJjRevision(pi, ctx.cwd, startInput, ctx.signal);

	const suggestedPath = defaultJjWorkspacePath(suggestionBase, name ?? "workspace", workspaceRoot);
	const requestedPath = await ctx.ui.input(
		stripTerminalControls(`Workspace path (blank uses ${suggestedPath})`),
		stripTerminalControls(suggestedPath),
	);
	if (requestedPath === undefined) return;
	const targetPath = pathIdentity(
		requestedPath.trim() ? resolve(ctx.cwd, requestedPath.trim()) : suggestedPath,
	);
	assertTargetFilesystemAvailable(targetPath);
	const pathCollision = records.find(
		(record) => record.path !== undefined && pathsEqual(record.path, targetPath),
	);
	if (pathCollision) {
		throw new Error(`The target path is already registered as a workspace: ${pathCollision.path}.`);
	}

	const summary =
		startInput === ""
			? `Create jj workspace at ${targetPath}?`
			: `Create jj workspace at ${targetPath} from ${startInput}?`;
	if (!(await ctx.ui.confirm("Create jj workspace", stripTerminalControls(summary)))) return;

	assertTargetFilesystemAvailable(targetPath);
	await addJjWorkspace(
		pi,
		ctx.cwd,
		{
			path: targetPath,
			...(name === undefined ? {} : { name }),
			...(startCommit === undefined ? {} : { startCommit }),
		},
		ctx.signal,
	);
	let created: JjWorkspaceRecord;
	try {
		const updated = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
		const verified = updated.find(
			(record) => record.path !== undefined && pathsEqual(record.path, targetPath),
		);
		if (!verified) {
			throw new Error("the expected path was not present in jj workspace list output");
		}
		created = verified;
	} catch (error) {
		throw new Error(
			`jj add completed, so the workspace was retained at ${targetPath}, but verification failed: ${formatError(error)}. Inspect jj workspace list before retrying.`,
		);
	}
	safeNotify(ctx, `Created jj workspace ${created.name} at ${targetPath}.`, "info");

	if (
		await ctx.ui.confirm(
			"Switch Pi workspace?",
			stripTerminalControls(`Continue this conversation in ${targetPath}?`),
		)
	) {
		const latest = await revalidateJjWorkspaceIdentity(pi, ctx, created);
		if (latest.path === undefined || latest.abandoned || !existsSync(latest.path)) {
			throw new Error("The newly created workspace became unavailable; select it again.");
		}
		await switchToWorktree(ctx, latest.path);
	}
}

async function jjSwitchFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly JjWorkspaceRecord[],
	currentPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const candidates = records.filter(
		(record) =>
			record.path !== undefined &&
			!record.abandoned &&
			existsSync(record.path) &&
			!pathsEqual(record.path, currentPath),
	);
	const selected = await selectJjWorkspace(
		ctx,
		"Switch to workspace",
		candidates,
		currentPath,
		signal,
	);
	if (!selected) return;
	const latest = await revalidateJjWorkspaceIdentity(pi, ctx, selected);
	if (
		latest.path === undefined ||
		latest.abandoned ||
		!existsSync(latest.path) ||
		pathsEqual(latest.path, currentPath)
	) {
		throw new Error("The selected workspace changed state; select it again.");
	}
	await switchToWorktree(ctx, latest.path);
}

async function jjRemoveFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	records: readonly JjWorkspaceRecord[],
	currentPath: string,
	mainRoot: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const candidates = records.filter(
		(record) =>
			record.path !== undefined &&
			!record.abandoned &&
			record.empty &&
			!record.conflict &&
			!pathsEqual(record.path, currentPath) &&
			mainRoot !== undefined &&
			!pathsEqual(record.path, mainRoot),
	);
	const selected = await selectJjWorkspace(
		ctx,
		"Remove workspace",
		candidates,
		currentPath,
		signal,
	);
	if (!selected) return;
	const selectedPath = selected.path;
	if (
		!(await ctx.ui.confirm(
			"Remove jj workspace",
			stripTerminalControls(
				`Forget the jj workspace ${selected.name} at ${selectedPath}? Its working copy commit is empty, so no changes are lost. jj never deletes directories; ${selectedPath} will be retained on disk.`,
			),
		))
	) {
		return;
	}
	const latest = await revalidateJjWorkspaceIdentity(pi, ctx, selected);
	if (
		latest.path === undefined ||
		latest.abandoned ||
		!latest.empty ||
		latest.conflict ||
		pathsEqual(latest.path, currentPath) ||
		(mainRoot !== undefined && pathsEqual(latest.path, mainRoot))
	) {
		throw new Error(
			`Workspace ${selected.name} changed state after confirmation; removal was refused.`,
		);
	}
	await forgetJjWorkspaces(pi, ctx.cwd, [latest.name], ctx.signal);
	const updated = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
	if (updated.some((record) => record.name === latest.name)) {
		throw new Error(`jj forget returned success, but ${latest.name} is still registered.`);
	}
	safeNotify(
		ctx,
		`Removed jj workspace ${latest.name}. Its directory was retained at ${latest.path}.`,
		"info",
	);
}

async function jjPruneFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const latest = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
	const stale = latest.filter((record) => record.abandoned || record.path === undefined);
	const blocked = stale.filter((record) => !record.abandoned && (!record.empty || record.conflict));
	if (blocked.length > 0) {
		throw new Error(
			`Prune refused because ${blocked.map((record) => record.name).join(", ")} ${blocked.length === 1 ? "has" : "have"} uncommitted or conflicted changes in ${blocked.length === 1 ? "its" : "their"} working copy commit. Preserve them with jj before forgetting ${blocked.length === 1 ? "the workspace" : "these workspaces"}.`,
		);
	}
	const candidates = stale.filter(
		(record) => record.abandoned || (record.empty && !record.conflict),
	);
	if (candidates.length === 0) {
		ctx.ui.notify("jj found no stale workspaces to prune.", "info");
		return;
	}
	const preview = candidates
		.map((record) =>
			record.abandoned
				? `${formatJjWorkspace(record)} (working copy commit already abandoned; nothing new is discarded)`
				: `${formatJjWorkspace(record)} (empty working copy commit will be forgotten)`,
		)
		.join("\n");
	ctx.ui.notify(`jj workspace forget preview\n${preview}`, "warning");
	if (
		!(await ctx.ui.confirm(
			"Prune stale jj workspaces",
			stripTerminalControls(
				`Forget ${candidates.length} stale jj workspace${candidates.length === 1 ? "" : "s"}? Directories are never deleted; empty or already-abandoned working copy commits are unlinked.`,
			),
		))
	) {
		return;
	}
	const revalidated = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
	for (const record of candidates) {
		const current = revalidated.find((candidate) => candidate.name === record.name);
		if (!current) {
			throw new Error(`Workspace ${record.name} is no longer registered; run prune again.`);
		}
		if (!sameJjWorkspaceIdentity(record, current)) {
			throw new Error(
				`Workspace ${record.name} changed state after confirmation; run prune again.`,
			);
		}
	}
	await forgetJjWorkspaces(
		pi,
		ctx.cwd,
		candidates.map((record) => record.name),
		ctx.signal,
	);
	const after = await listJjWorkspaces(pi, ctx.cwd, ctx.signal);
	const missing = candidates.filter((record) =>
		after.some((candidate) => candidate.name === record.name),
	);
	if (missing.length > 0) {
		throw new Error(
			`jj forget returned success, but ${missing.map((record) => record.name).join(", ")} is still registered.`,
		);
	}
	safeNotify(
		ctx,
		`Pruned ${candidates.length} stale jj workspace${candidates.length === 1 ? "" : "s"}.`.trimEnd(),
		"info",
	);
}

async function assertAdministrativeHistoryUnchanged(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selectedPath: string,
	approvedAdministrativePath: string,
	approvedHistoryRisks: readonly AdministrativeHistoryRisk[],
): Promise<void> {
	const latestAdministrativePath = await worktreeAdministrativeDirectory(
		pi,
		selectedPath,
		ctx.signal,
	);
	const latestHistoryRisks = historyRisks(
		selectedPath,
		await unreachableAdministrativeHistoryOids(pi, ctx, latestAdministrativePath),
	);
	if (
		!pathsEqual(approvedAdministrativePath, latestAdministrativePath) ||
		!sameAdministrativeHistoryRisks(approvedHistoryRisks, latestHistoryRisks)
	) {
		throw new Error(
			`Worktree ${selectedPath} administrative recovery history changed after confirmation; select it again.`,
		);
	}
}

async function inspectAdministrativePruneCandidates(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<AdministrativeHistoryRisk[]> {
	const risks: AdministrativeHistoryRisk[] = [];
	for (const candidate of await administrativePruneCandidates(pi, ctx.cwd, ctx.signal)) {
		if (candidate.indexDirty) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} contains staged-only index changes.`,
			);
		}
		if (candidate.head) {
			const refs = await durableRefsContaining(pi, ctx.cwd, candidate.head, ctx.signal);
			if (refs.length === 0) {
				throw new Error(
					`Prune refused because administrative worktree ${candidate.id} has detached HEAD ${candidate.head}, which is not reachable from a durable ref.`,
				);
			}
		} else if (
			!candidate.branchRef ||
			!(await durableRefExists(pi, ctx.cwd, candidate.branchRef, ctx.signal))
		) {
			throw new Error(
				`Prune refused because administrative worktree ${candidate.id} does not resolve to a durable ref.`,
			);
		}
		risks.push(
			...historyRisks(
				candidate.id,
				await unreachableAdministrativeHistoryOids(pi, ctx, candidate.administrativePath),
			),
		);
	}
	return normalizeAdministrativeHistoryRisks(risks);
}

async function unreachableAdministrativeHistoryOids(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	administrativePath: string,
): Promise<string[]> {
	const unreachable: string[] = [];
	for (const oid of await administrativeHistoryOids(pi, ctx.cwd, administrativePath, ctx.signal)) {
		const refs = await durableRefsContaining(pi, ctx.cwd, oid, ctx.signal);
		if (refs.length === 0) unreachable.push(oid);
	}
	return [...new Set(unreachable)].sort();
}

function historyRisks(label: string, oids: string[]): AdministrativeHistoryRisk[] {
	return oids.length > 0 ? [{ label, oids }] : [];
}

function normalizeAdministrativeHistoryRisks(
	risks: readonly AdministrativeHistoryRisk[],
): AdministrativeHistoryRisk[] {
	return risks
		.map((risk) => ({ label: risk.label, oids: [...new Set(risk.oids)].sort() }))
		.filter((risk) => risk.oids.length > 0)
		.sort((left, right) => left.label.localeCompare(right.label));
}

function sameAdministrativeHistoryRisks(
	left: readonly AdministrativeHistoryRisk[],
	right: readonly AdministrativeHistoryRisk[],
): boolean {
	return (
		JSON.stringify(normalizeAdministrativeHistoryRisks(left)) ===
		JSON.stringify(normalizeAdministrativeHistoryRisks(right))
	);
}

function formatAdministrativeRecoveryWarning(risks: readonly AdministrativeHistoryRisk[]): string {
	if (risks.length === 0) return "";
	const entries = risks
		.map(
			(risk) =>
				`${stripTerminalControls(risk.label)}: ${risk.oids.map(stripTerminalControls).join(", ")}`,
		)
		.join("; ");
	return ` Administrative recovery warning: these commits are not reachable from a branch, tag, or remote ref: ${entries}. Discarding their recovery pointers means they may later be garbage-collected.`;
}

interface RemovalInventory {
	ignored: string[];
	protected: string[];
}

function classifyRemovalInventory(lines: readonly string[]): RemovalInventory {
	const ignored: string[] = [];
	const protectedData: string[] = [];
	for (const line of lines) {
		(line.startsWith("!! ") ? ignored : protectedData).push(line);
	}
	return {
		ignored: normalizeInventory(ignored),
		protected: normalizeInventory(protectedData),
	};
}

function normalizeInventory(lines: readonly string[]): string[] {
	return [...new Set(lines)].sort();
}

function sameInventory(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(normalizeInventory(left)) === JSON.stringify(normalizeInventory(right));
}

function formatIgnoredDataWarning(ignored: readonly string[]): string {
	if (ignored.length === 0) return "";
	return ` Ignored files and directories that will be deleted:\n${ignored.map(stripTerminalControls).join("\n")}`;
}

async function assertDetachedHeadIsDurable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	record: WorktreeRecord,
): Promise<void> {
	if (!record.detached) return;
	if (!record.head)
		throw new Error(`Detached worktree ${record.path} has no HEAD object; refusing.`);
	const refs = await durableRefsContaining(pi, ctx.cwd, record.head, ctx.signal);
	if (refs.length === 0) {
		throw new Error(
			`Detached HEAD ${record.head} at ${record.path} is not reachable from a local branch, tag, or remote ref. Preserve it before continuing.`,
		);
	}
}

async function revalidateWorktreeIdentity(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selected: WorktreeRecord,
): Promise<WorktreeRecord> {
	const latest = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find((record) =>
		pathsEqual(record.path, selected.path),
	);
	if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
	if (!sameWorktreeIdentity(selected, latest)) {
		throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
	}
	return latest;
}

async function revalidateJjWorkspaceIdentity(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selected: JjWorkspaceRecord,
): Promise<JjWorkspaceRecord> {
	const latest = (await listJjWorkspaces(pi, ctx.cwd, ctx.signal)).find(
		(record) => record.name === selected.name,
	);
	if (!latest) throw new Error(`Workspace ${selected.name} is no longer registered.`);
	if (!sameJjWorkspaceIdentity(selected, latest)) {
		throw new Error(`Workspace ${selected.name} changed identity; select it again.`);
	}
	return latest;
}

async function selectWorktree(
	ctx: ExtensionCommandContext,
	title: string,
	records: readonly WorktreeRecord[],
	currentPath: string,
	signal?: AbortSignal,
): Promise<WorktreeRecord | undefined> {
	if (records.length === 0) {
		ctx.ui.notify("No eligible worktrees are available for this action.", "info");
		return undefined;
	}
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (signal?.aborted || ctx.signal?.aborted) return undefined;
	let selected: WorktreeRecord | undefined;
	const menu = defineMenu<undefined, "worktrees", "choose", ExtensionCommandContext>({
		start: "worktrees",
		screens: {
			worktrees: () => ({
				kind: "choice",
				title,
				enableSearch: true,
				items: records.map((record, index) => ({
					id: record.path,
					label: `${index + 1}. ${formatWorktree(record, currentPath)}`,
					searchText: [record.path, record.branch, record.head].filter(Boolean).join(" "),
				})),
				action: "choose",
				hint: "close",
			}),
		},
		actions: {
			choose: async ({ itemId }) => {
				selected = records.find((record) => record.path === itemId);
				return selected ? { kind: "close" } : { kind: "rejected" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal,
		isCurrent: () => !signal?.aborted,
	});
	return selected;
}

async function selectJjWorkspace(
	ctx: ExtensionCommandContext,
	title: string,
	records: readonly JjWorkspaceRecord[],
	currentPath: string,
	signal?: AbortSignal,
): Promise<JjWorkspaceRecord | undefined> {
	if (records.length === 0) {
		ctx.ui.notify("No eligible workspaces are available for this action.", "info");
		return undefined;
	}
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (signal?.aborted || ctx.signal?.aborted) return undefined;
	let selected: JjWorkspaceRecord | undefined;
	const menu = defineMenu<undefined, "workspaces", "choose", ExtensionCommandContext>({
		start: "workspaces",
		screens: {
			workspaces: () => ({
				kind: "choice",
				title,
				enableSearch: true,
				items: records.map((record, index) => ({
					id: record.name,
					label: `${index + 1}. ${formatJjWorkspace(record, currentPath)}`,
					searchText: [record.path, record.name, record.changeId].filter(Boolean).join(" "),
				})),
				action: "choose",
				hint: "close",
			}),
		},
		actions: {
			choose: async ({ itemId }) => {
				selected = records.find((record) => record.name === itemId);
				return selected ? { kind: "close" } : { kind: "rejected" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal,
		isCurrent: () => !signal?.aborted,
	});
	return selected;
}

function safeNotify(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	try {
		ctx.ui.notify(stripTerminalControls(message), level);
	} catch {
		console.error(message);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
