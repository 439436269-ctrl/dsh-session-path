/**
 * Locate a session's on-disk home.
 *
 * DSH stores one directory per session under `$DSH_HOME/sessions/<project>/`,
 * where `<project>` is derived from the workspace cwd and the session directory
 * is either the bare session id or `session-<id>` (the naming changed across
 * releases). Each session directory holds one committed log per generation:
 * `session[.vN].jsonl[.zstd]`.
 *
 * Both the derived-project fast path and a full scan are provided: the scan is
 * authoritative and never edits anything, it only enumerates directories.
 *
 * @module dsh-session-path/paths
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical committed artifacts only: backups, temp files and aliases are not logs. */
const LOG_FILE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;

/**
 * `$DSH_HOME`, resolved from the host service, the environment, then `~/.dsh`.
 *
 * @param ctx - host plugin context (may be a bare object in tests).
 * @returns the absolute DSH home path.
 */
export function dshHome(ctx) {
	const service = ctx?.get?.("dshHomePath");
	if (typeof service === "function") {
		try {
			const resolved = service();
			if (typeof resolved === "string" && resolved.length > 0) return resolved;
		} catch {
			/* fall through to the environment */
		}
	}
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".dsh");
}

/**
 * The sessions root: `$DSH_HOME/sessions`.
 *
 * @param ctx - host plugin context.
 * @returns the absolute sessions root.
 */
export function sessionsRoot(ctx) {
	return join(dshHome(ctx), "sessions");
}

/**
 * Parse a log file name into its generation, or null when it is not a log.
 *
 * @param name - base name of the candidate file.
 * @returns `{ version, compressed }` or null.
 */
export function logGeneration(name) {
	const match = LOG_FILE.exec(name);
	if (match === null) return null;
	const version = Number(match[1] ?? 0);
	return Number.isSafeInteger(version) ? { version, compressed: Boolean(match[2]) } : null;
}

/**
 * Committed logs of one session directory, newest generation first.
 *
 * Numeric generations order numerically (`v10` beats `v3`), and a compressed
 * artifact wins over a plain one of the same generation.
 *
 * @param directory - session directory.
 * @returns absolute log paths, best candidate first.
 */
export function listSessionLogs(directory) {
	let names;
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	return names
		.map((name) => ({ name, generation: logGeneration(name) }))
		.filter((entry) => entry.generation !== null)
		.sort((a, b) => b.generation.version - a.generation.version || Number(b.generation.compressed) - Number(a.generation.compressed))
		.map((entry) => join(directory, entry.name));
}

/**
 * The directory name DSH derives from a workspace path.
 *
 * Mirrors the host's project-directory rule: separators become `-`, and the
 * result is fenced by `-` / `--`. This is a fast path only — {@link findSessionDirectory}
 * falls back to a full scan when the guess misses.
 *
 * @param cwd - the session's workspace directory.
 * @returns the derived project directory name.
 */
export function projectDirectoryName(cwd) {
	return `-${String(cwd).replace(/[\\/]/g, "-")}--`;
}

/**
 * Both spellings a session directory may use, longest-lived first.
 *
 * @param sessionId - the session id as DSH reports it.
 * @returns candidate directory names.
 */
export function sessionDirectoryNames(sessionId) {
	const id = String(sessionId);
	const bare = id.startsWith("session-") ? id.slice("session-".length) : id;
	return [...new Set([id, bare, `session-${bare}`])];
}

/**
 * Find one session's directory under the sessions root.
 *
 * @param root - sessions root.
 * @param sessionId - session id (with or without the `session-` prefix).
 * @param cwd - optional workspace directory used for the derived fast path.
 * @returns `{ dir, project, logs }`, or null when nothing matches.
 */
export function findSessionDirectory(root, sessionId, cwd) {
	const names = sessionDirectoryNames(sessionId);
	const projects = [];
	if (typeof cwd === "string" && cwd.length > 0) projects.push(projectDirectoryName(cwd));
	let candidates = [];
	try {
		candidates = readdirSync(root);
	} catch {
		return null;
	}
	for (const project of candidates) {
		if (!projects.includes(project)) projects.push(project);
	}
	let emptyMatch = null;
	for (const project of projects) {
		for (const name of names) {
			const dir = join(root, project, name);
			let stats;
			try {
				stats = statSync(dir);
			} catch {
				continue;
			}
			if (!stats.isDirectory()) continue;
			const logs = listSessionLogs(dir);
			if (logs.length > 0) return { dir, project, logs };
			emptyMatch ??= { dir, project, logs: [] };
		}
	}
	return emptyMatch;
}
