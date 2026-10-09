/**
 * Resolve everything a caller needs to know about one session: its id, title,
 * workspace directory and the absolute path of its committed log.
 *
 * The workspace directory comes from the live session header when the session is
 * mounted, and the log path comes from an authoritative directory lookup — never
 * from a derived guess alone, so a renamed project folder cannot produce a path
 * that does not exist.
 *
 * @module dsh-session-path/session-info
 */

import { findSessionDirectory, sessionsRoot } from "./paths.js";
import { readSessionRecords } from "./zstd.js";

/** Longest accepted session id / title / cwd hint (untrusted input from the GUI). */
const MAX_HINT_CHARS = 4096;

/**
 * The live session header, when the host's session store has the session.
 *
 * @param ctx - host plugin context.
 * @param sessionId - session id.
 * @returns the header object, or an empty object.
 */
export function liveSessionHeader(ctx, sessionId) {
	try {
		const sessions = ctx?.get?.("sessions");
		const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
		const header = session?.header;
		return header !== null && typeof header === "object" ? header : {};
	} catch {
		return {};
	}
}

/**
 * Normalise one untrusted string hint (or an empty string).
 *
 * @param value - candidate value.
 * @returns the trimmed value within the length cap.
 */
function hint(value) {
	return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_HINT_CHARS) : "";
}

/**
 * The session's title from its log, taken from the last `session/title` event
 * inside a bounded prefix of the file.
 *
 * @param file - log path.
 * @param maxBytes - compressed byte budget.
 * @returns the title, or an empty string.
 */
export async function readSessionTitle(file, maxBytes) {
	let title = "";
	try {
		for await (const record of readSessionRecords(file, { maxBytes })) {
			if (record.type !== "session/title") continue;
			const next = record.data?.title;
			if (typeof next === "string" && next.trim().length > 0) title = next.trim();
		}
	} catch {
		/* the title is cosmetic: a damaged log must not fail the whole call */
	}
	return title;
}

/**
 * The session's own header record from the log (`{ type: "session", cwd, ... }`).
 *
 * A cold session — one this process never mounted — has no live header, and the
 * workspace directory is what a continuation needs most. The header is the first
 * record of the first frame, so a small byte budget is always enough.
 *
 * @param file - log path.
 * @param maxBytes - compressed byte budget.
 * @returns the header record, or null.
 */
export async function readSessionHeader(file, maxBytes = 262_144) {
	try {
		for await (const record of readSessionRecords(file, { maxBytes })) {
			if (record.type === "session") return record;
		}
	} catch {
		/* fall through: an unknown cwd is reported as empty */
	}
	return null;
}

/**
 * Everything the tools and the HTTP route need about one session.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @param sessionId - the session to resolve.
 * @param hints - optional GUI-supplied `{ title, cwd }` (cosmetic, unverified).
 * @returns the resolved session info.
 */
export async function resolveSessionInfo(ctx, settings, sessionId, hints = {}) {
	const id = hint(sessionId);
	if (id === "") throw new Error("session id is required");
	const header = liveSessionHeader(ctx, id);
	const hintedCwd = hint(hints.cwd);
	const liveCwd = hint(header.cwd);
	const root = sessionsRoot(ctx);
	const found = findSessionDirectory(root, id, liveCwd || hintedCwd);
	const logs = found?.logs ?? [];
	const logPath = logs[0] ?? "";
	let cwd = liveCwd || hintedCwd;
	if (cwd === "" && logPath !== "") cwd = hint((await readSessionHeader(logPath))?.cwd);
	let title = hint(hints.title);
	if (title === "" && logPath !== "") title = await readSessionTitle(logPath, settings.titleScanBytes);
	return {
		sessionId: id,
		title,
		cwd,
		logPath,
		dir: found?.dir ?? "",
		project: found?.project ?? "",
		root,
		exists: logPath !== "",
	};
}
