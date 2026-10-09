/**
 * The two agent-facing tools.
 *
 * `session_path` answers "where is this session's log?" (no writes), and
 * `session_handoff` answers "give me something I can actually read" by writing a
 * decompressed transcript next to the DSH home. Together they are how one
 * session hands its context to another.
 *
 * @module dsh-session-path/tools
 */

import { composeCopyText } from "./copy-text.js";
import { writeHandoff } from "./handoff.js";
import { resolveSessionInfo } from "./session-info.js";

/**
 * The session a call targets: the explicit argument, else the calling session.
 *
 * @param args - tool arguments.
 * @param exec - tool execution context.
 * @returns the session id.
 */
function targetSessionId(args, exec) {
	const explicit = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
	if (explicit !== "") return explicit;
	const own = exec?.agent?.session?.id;
	if (typeof own === "string" && own !== "") return own;
	throw new Error("no session id: pass sessionId, or call this from inside a session");
}

/** Shared `sessionId` parameter description. */
const SESSION_ID_PARAM = {
	type: "string",
	description: "Session id to inspect. Omit to use the session this call runs in (`session-<uuid>` and bare-uuid spellings are both accepted).",
};

/**
 * Build both tool specs bound to one plugin instance.
 *
 * @param options - `{ ctx, settings }`.
 * @returns tool specs consumed by the entry point.
 */
export function createToolSpecs({ ctx, settings }) {
	return [
		{
			name: "session_path",
			description:
				"Resolve a DSH session's on-disk log path and workspace directory. Use when the user asks to copy a session's path, to check where a session is stored, or to hand a session off to another session. Omit sessionId for the current session. Read-only: nothing is written.",
			parameters: {
				sessionId: SESSION_ID_PARAM,
				format: {
					type: "string",
					description: 'Copy payload: "path" (bare log path) or "block" (paste-ready handoff block, default).',
				},
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					sessionId: { type: "string", required: true },
					title: { type: "string", required: true },
					cwd: { type: "string", required: true },
					logPath: { type: "string", required: true },
					dir: { type: "string", required: true },
					exists: { type: "boolean", required: true },
					text: { type: "string", required: true },
				},
			},
			presentCall: (args) => ({ card: "generic", title: "session_path", kind: "execute", detail: args?.sessionId ?? "" }),
			render: (_args, value) =>
				value.exists
					? [
							{ type: "text", text: `会话 ${value.sessionId} 的日志：${value.logPath}` },
							{ type: "text", text: value.text },
						]
					: [{ type: "text", text: `未找到会话 ${value.sessionId} 的日志文件（sessions 根：${value.dir === "" ? "?" : value.dir}）。` }],
			async execute(args, exec) {
				const sessionId = targetSessionId(args, exec);
				const format = args?.format === "path" ? "path" : settings.copyFormat;
				const info = await resolveSessionInfo(ctx, settings, sessionId, {});
				return {
					ok: true,
					sessionId: info.sessionId,
					title: info.title,
					cwd: info.cwd,
					logPath: info.logPath,
					dir: info.dir,
					exists: info.exists,
					text: composeCopyText(info, format),
				};
			},
		},
		{
			name: "session_handoff",
			description:
				"Write a readable, decompressed copy of a DSH session (Markdown transcript by default) and return its absolute path. Use to continue another session's work: call this, then `read` the returned file. Omit sessionId for the current session.",
			parameters: {
				sessionId: SESSION_ID_PARAM,
				format: {
					type: "string",
					description: 'Output file: "md" (human/agent-readable transcript, default) or "jsonl" (plain decompressed event log).',
				},
				maxChars: {
					type: "integer",
					description: "Character budget for the written file; the most recent part of the session is kept. Defaults to the plugin setting (200000).",
				},
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					sessionId: { type: "string", required: true },
					title: { type: "string", required: true },
					cwd: { type: "string", required: true },
					logPath: { type: "string", required: true },
					file: { type: "string", required: true },
					format: { type: "string", required: true },
					chars: { type: "integer", required: true },
					kept: { type: "integer", required: true },
					truncated: { type: "boolean", required: true },
				},
			},
			presentCall: (args) => ({ card: "generic", title: "session_handoff", kind: "execute", detail: args?.sessionId ?? "" }),
			render: (_args, value) => {
				const lines = [
					`会话记录已写出：${value.file}`,
					`格式 ${value.format} · ${value.chars} 字符 · ${value.kept} 条${value.truncated ? "（仅最近部分，前文已截断）" : ""}`,
					`工作目录：${value.cwd === "" ? "(未知)" : value.cwd}`,
					`原始日志：${value.logPath}`,
					`下一步：用 read 读取 ${value.file} 即可接续该会话。`,
				];
				return [{ type: "text", text: lines.join("\n") }];
			},
			async execute(args, exec) {
				const sessionId = targetSessionId(args, exec);
				const info = await resolveSessionInfo(ctx, settings, sessionId, {});
				if (!info.exists) {
					throw new Error(`no committed log found for session "${info.sessionId}" under ${info.root}; check the session id`);
				}
				const format = args?.format === "jsonl" ? "jsonl" : args?.format === "md" ? "md" : settings.handoffFormat;
				const result = await writeHandoff(ctx, settings, info, {
					format,
					maxChars: Number(args?.maxChars) > 0 ? Number(args.maxChars) : undefined,
				});
				return {
					ok: true,
					sessionId: info.sessionId,
					title: info.title,
					cwd: info.cwd,
					logPath: info.logPath,
					file: result.file,
					format: result.format,
					chars: result.chars,
					kept: result.kept,
					truncated: result.truncated,
				};
			},
		},
	];
}
