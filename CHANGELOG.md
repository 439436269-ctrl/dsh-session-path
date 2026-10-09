# Changelog

## 0.1.2

- README 加了界面截图：会话标题栏的 ⧉ 按钮，以及侧栏会话行菜单里的
  「复制会话路径」（图片在 `docs/`，README 用绝对 raw 地址引用，npm 页面上也能显示）。
- 仅文档变更，代码与 0.1.1 一致。

## 0.1.1

- Sidebar session rows: 「复制会话路径」 in the row's `⋯` / right-click menu
  (`sidebar.workspaces.session.menu.item`, order 500), so any session's path can
  be copied without opening it; a transient toast confirms the write.
- Menu rows reuse the host's `MenuItemButton` when available and fall back to a
  plain `role="menuitem"` button.
- Self-test: added a client-bundle structure check; container checks now skip
  gracefully on runtimes without Zstandard (CI-friendly), and the real-log pass
  is skipped when the machine has no session logs.

## 0.1.0

- First release.
- Session header action (⧉) copies a paste-ready handoff block: title, session
  id, workspace directory and the absolute log path.
- `session_path` tool: read-only path/info lookup for any session.
- `session_handoff` tool: renders a session log into a readable Markdown
  transcript (or plain JSONL) and returns its path, keeping the newest part
  within the configured character budget.
- Reads DSH's multi-frame Zstandard session logs frame by frame.
- Read-only HTTP route `/api/dsh-session-path/resolve` behind a loopback /
  trusted-host fence.
