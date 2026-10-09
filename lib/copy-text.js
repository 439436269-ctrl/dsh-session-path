/**
 * Compose the clipboard payload for one session.
 *
 * `path` is the bare log-file path; `block` is a paste-ready handoff a user can
 * drop into any other session, and it names the tool that turns the compressed
 * log into something the other agent can simply read.
 *
 * @module dsh-session-path/copy-text
 */

/**
 * Build the copied text for one resolved session.
 *
 * @param info - result of `resolveSessionInfo`.
 * @param format - `path` or `block`.
 * @returns the clipboard string.
 */
export function composeCopyText(info, format) {
	if (format === "path") return info.logPath;
	const lines = [];
	lines.push(`【接续会话】${info.title === "" ? "(无标题)" : info.title}`);
	lines.push(`会话 ID：${info.sessionId}`);
	if (info.cwd !== "") lines.push(`工作目录：${info.cwd}`);
	lines.push(`会话日志：${info.logPath === "" ? "(未找到日志文件)" : info.logPath}`);
	lines.push("");
	lines.push(`提示：日志是 zstd 多帧压缩的 JSONL。在任意 DSH 会话里调用工具 session_handoff({ sessionId: "${info.sessionId}" }) 可直接得到解压后的可读记录路径，再 read 它即可接续。`);
	return lines.join("\n");
}
