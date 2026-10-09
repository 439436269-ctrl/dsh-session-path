/**
 * The system-prompt contribution.
 *
 * Kept short on purpose: it only has to tell the model that a session's context
 * is reachable from disk and which tool to use, so that "接着另一个会话继续"
 * becomes a two-step operation instead of a dead end.
 *
 * @module dsh-session-path/prompt
 */

/**
 * Guide text for the current settings.
 *
 * @param settings - resolved plugin settings.
 * @returns the prompt section body.
 */
export function guideText(settings) {
	return [
		"## 会话路径与接续（dsh-session-path）",
		"",
		"- 每个 DSH 会话的原始日志在 `$DSH_HOME/sessions/<工作区>/<会话目录>/session[.vN].jsonl[.zstd]`；`.zstd` 是多帧 Zstandard 容器，直接 read 会失败。",
		"- 要接着另一个会话继续干活：先调用 `session_handoff`（传 `sessionId`，省略则取当前会话）拿到解压后的可读文件路径，再用 read 读取它。",
		"- 只是想知道/复制会话路径时用 `session_path`（只读，不落盘）。",
		`- 交接文件默认写到 \`${settings.handoffDir === "" ? "$DSH_HOME/session-handoff" : settings.handoffDir}\`，格式 \`${settings.handoffFormat}\`，字符预算 ${settings.maxHandoffChars}（保留最近的部分）。`,
	].join("\n");
}
