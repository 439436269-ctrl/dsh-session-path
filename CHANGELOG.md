# Changelog

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
