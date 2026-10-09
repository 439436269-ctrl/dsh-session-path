/**
 * Turn a session log into a readable handoff file.
 *
 * The raw log is a compressed event stream: another agent can find it but cannot
 * `read` it. This module renders the parts a continuation actually needs —
 * user messages, assistant text, and the tool calls between them — and writes
 * either a Markdown transcript or the decompressed JSONL, keeping the **tail**
 * of the session when the character budget bites (the most recent turns are what
 * a continuation must see).
 *
 * @module dsh-session-path/handoff
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readSessionRecords } from "./zstd.js";
import { dshHome } from "./paths.js";

/** Longest tool-call rendering kept per call. */
const TOOL_ARG_CHARS = 240;
/** Longest single message kept verbatim. */
const MESSAGE_CHARS = 20_000;

/**
 * Join the text blocks of one message.
 *
 * @param content - message content array.
 * @returns the concatenated text.
 */
function messageText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		if (block.type !== "text" || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/**
 * One short line for a tool call, so the transcript records what was run.
 *
 * @param record - a `tool/call` record.
 * @returns the rendered line.
 */
function toolLine(record) {
	const name = typeof record.data?.name === "string" ? record.data.name : "tool";
	const raw = typeof record.data?.arguments === "string" ? record.data.arguments : "";
	const args = raw.length > TOOL_ARG_CHARS ? `${raw.slice(0, TOOL_ARG_CHARS)}…` : raw;
	return `- \`${name}\` ${args}`.trimEnd();
}

/**
 * Render one record as a transcript entry, or null when it is not user-visible.
 *
 * @param record - a parsed log record.
 * @returns `{ role, text }` or null.
 */
function toEntry(record) {
	switch (record.type) {
		case "user/message": {
			const text = messageText(record.data?.content);
			const kind = record.data?.source?.kind;
			if (text === "") return null;
			// Plugin injections are host bookkeeping, not something the user said.
			if (typeof kind === "string" && kind !== "user") return { role: "context", text };
			return { role: "user", text };
		}
		case "assistant/message": {
			const text = messageText(record.data?.message?.content);
			return text === "" ? null : { role: "assistant", text };
		}
		case "tool/call":
			return { role: "tool", text: toolLine(record) };
		default:
			return null;
	}
}

/** Markdown heading per entry role. */
const HEADING = { user: "## 用户", assistant: "## 助手", tool: "## 工具调用", context: "## 上下文注入" };

/**
 * Render the transcript, keeping the most recent entries within `maxChars`.
 *
 * @param entries - transcript entries in log order.
 * @param maxChars - character budget for the entry bodies.
 * @returns `{ body, kept, truncated }`.
 */
export function renderEntries(entries, maxChars) {
	const kept = [];
	let used = 0;
	let truncated = false;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		const text = entry.text.length > MESSAGE_CHARS ? `${entry.text.slice(0, MESSAGE_CHARS)}\n…（本条已截断）` : entry.text;
		const size = text.length + HEADING[entry.role].length + 4;
		if (kept.length > 0 && used + size > maxChars) {
			truncated = true;
			break;
		}
		kept.push({ ...entry, text });
		used += size;
	}
	kept.reverse();
	const body = kept.map((entry) => `${HEADING[entry.role]}\n\n${entry.text}`).join("\n\n");
	return { body, kept: kept.length, truncated };
}

/**
 * Markdown handoff: a header block plus the tail of the transcript.
 *
 * @param info - resolved session info.
 * @param entries - transcript entries.
 * @param maxChars - character budget.
 * @returns `{ text, kept, truncated }`.
 */
export function renderMarkdown(info, entries, maxChars) {
	const { body, kept, truncated } = renderEntries(entries, maxChars);
	const header = [
		"# 会话接续记录",
		"",
		`- 会话 ID：${info.sessionId}`,
		`- 标题：${info.title === "" ? "(无标题)" : info.title}`,
		`- 工作目录：${info.cwd === "" ? "(未知)" : info.cwd}`,
		`- 会话日志：${info.logPath === "" ? "(未找到)" : info.logPath}`,
		`- 导出时间：${new Date().toISOString()}`,
		`- 导出条目：${kept}${truncated ? "（仅保留最近部分，前文已截断）" : ""}`,
		"",
		"---",
		"",
	];
	return { text: `${header.join("\n")}${body}\n`, kept, truncated };
}

/**
 * JSONL handoff: one header line plus the decompressed records.
 *
 * @param info - resolved session info.
 * @param records - parsed records in log order.
 * @param maxChars - character budget.
 * @returns `{ text, kept, truncated }`.
 */
export function renderJsonl(info, records, maxChars) {
	const header = {
		type: "session/handoff",
		sessionId: info.sessionId,
		title: info.title,
		cwd: info.cwd,
		logPath: info.logPath,
		exportedAt: new Date().toISOString(),
	};
	const lines = [JSON.stringify(header)];
	let used = lines[0].length;
	let kept = 0;
	for (const record of records) {
		const line = JSON.stringify(record);
		if (used + line.length > maxChars) break;
		lines.push(line);
		used += line.length + 1;
		kept += 1;
	}
	return { text: `${lines.join("\n")}\n`, kept, truncated: kept < records.length };
}

/**
 * Where handoff files live: the configured directory, else `$DSH_HOME/session-handoff`.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @returns the absolute directory.
 */
export function handoffDirectory(ctx, settings) {
	return settings.handoffDir !== "" ? settings.handoffDir : join(dshHome(ctx), "session-handoff");
}

/**
 * Build one handoff file for a session and return where it landed.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @param info - resolved session info.
 * @param options - `{ format?, maxChars? }`.
 * @returns `{ file, chars, kept, truncated, format }`.
 */
export async function writeHandoff(ctx, settings, info, options = {}) {
	const format = options.format === "jsonl" ? "jsonl" : settings.handoffFormat;
	const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : settings.maxHandoffChars;
	if (info.logPath === "") throw new Error(`no committed log found for session "${info.sessionId}"`);
	const directory = handoffDirectory(ctx, settings);
	await mkdir(directory, { recursive: true });
	let text;
	let kept;
	let truncated;
	if (format === "jsonl") {
		const records = [];
		for await (const record of readSessionRecords(info.logPath)) records.push(record);
		const rendered = renderJsonl(info, records, maxChars);
		text = rendered.text;
		kept = rendered.kept;
		truncated = rendered.truncated;
	} else {
		const entries = [];
		for await (const record of readSessionRecords(info.logPath)) {
			const entry = toEntry(record);
			if (entry !== null) entries.push(entry);
		}
		const rendered = renderMarkdown(info, entries, maxChars);
		text = rendered.text;
		kept = rendered.kept;
		truncated = rendered.truncated;
	}
	const safeId = info.sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	const file = join(directory, `${safeId}.${format === "jsonl" ? "jsonl" : "md"}`);
	await writeFile(file, text, "utf8");
	return { file, chars: text.length, kept, truncated, format };
}
