/**
 * dsh-session-path — browser half.
 *
 * Two places to copy a session's path:
 *
 *  1. the session header's action row (the currently open session), and
 *  2. the sidebar session row's "..." menu, next to 置顶 / 重命名 / 分叉 / 归档
 *     — `sidebar.workspaces.session.menu.item`, a `list` slot the host's own
 *     actions use too, so any session can be copied without opening it.
 *
 * Both paths ask the host half for the payload (one source of truth for the
 * path, the workspace and the copy format) and only own the clipboard write and
 * its transient feedback.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-path",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;
		// The Module Loader exposes the UI primitives as a baseline external (see
		// the host's client-plugin docs); a missing copy must not break the slot,
		// so the menu item falls back to a plain role="menuitem" button.
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			console.warn("[dsh-session-path] ui-primitives unavailable, using a plain menu button:", error);
		}
		const MenuItemButton = primitives?.MenuItemButton ?? null;

		/** Exact route the host half registers. */
		const ROUTE = "/api/dsh-session-path/resolve";
		/** The session header action row. */
		const SLOT = "conversation.session.header.actions";
		/** The sidebar session row's "..." menu. */
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		/** How long the "copied" / "failed" feedback stays. */
		const FEEDBACK_MS = 1800;

		//#region styles
		const CSS = [
			".dshsp_btn{box-sizing:border-box;width:24px;height:24px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".dshsp_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e8ee)}",
			".dshsp_btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#5b8def));outline-offset:1px}",
			".dshsp_btn[data-phase=busy]{opacity:.55;cursor:progress}",
			".dshsp_btn[data-phase=copied]{color:var(--dsw-alias-state-success-primary,#34a853)}",
			".dshsp_btn[data-phase=failed]{color:var(--dsw-alias-state-warning-primary,#e0a03a)}",
			".dshsp_menuItem{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:8px;padding:6px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ee);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm,4px)}",
			".dshsp_menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
			".dshsp_toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#1f2430);color:var(--dsw-alias-label-primary,#e6e8ee);box-shadow:0 6px 22px rgba(0,0,0,.35);font-size:13px;line-height:18px;pointer-events:none}",
			".dshsp_toast[data-ok=false]{color:var(--dsw-alias-state-warning-primary,#e0a03a)}",
		].join("");
		const tagId = "dsh-session-path/header-action.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-path";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region copy
		/** Put `text` on the clipboard, falling back to the legacy selection path. */
		async function writeClipboard(text) {
			try {
				if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* fall through to the legacy path */
			}
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
			document.body.appendChild(area);
			try {
				area.select();
				return document.execCommand("copy") === true;
			} catch {
				return false;
			} finally {
				area.remove();
			}
		}

		/**
		 * Ask the host half for one session's payload and copy it.
		 * @param sessionId - the session to copy.
		 * @returns the copied text.
		 */
		async function copyFor(sessionId) {
			const params = new URLSearchParams({ sessionId });
			const response = await fetch(ROUTE + "?" + params.toString(), { headers: { accept: "application/json" } });
			const body = await response.json().catch(() => null);
			if (!response.ok || body === null || body.ok !== true) {
				throw new Error(body?.error?.message ?? "HTTP " + response.status);
			}
			const text = typeof body.value?.text === "string" && body.value.text !== "" ? body.value.text : body.value?.logPath ?? "";
			if (!(await writeClipboard(text))) throw new Error("clipboard write was refused");
			return text;
		}

		/** A short-lived, click-through confirmation banner. */
		function toast(text, ok) {
			try {
				const node = document.createElement("div");
				node.className = "dshsp_toast";
				node.dataset.ok = ok ? "true" : "false";
				node.setAttribute("role", "status");
				node.textContent = text;
				document.body.appendChild(node);
				window.setTimeout(() => node.remove(), FEEDBACK_MS);
			} catch {
				/* feedback is best-effort */
			}
		}
		//#endregion

		//#region icons
		/** Lucide-style outline copy glyph, currentColor, 16px. */
		function CopyIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("rect", { x: 9, y: 9, width: 12, height: 12, rx: 2 }),
				h("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }),
			);
		}

		/** Check glyph for the copied state. */
		function CheckIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M20 6 9 17l-5-5" }),
			);
		}

		/** Warning glyph for the failed state. */
		function WarnIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M12 9v4" }),
				h("path", { d: "M12 17h.01" }),
				h("path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" }),
			);
		}
		//#endregion

		//#region labels
		/** Bilingual labels, picked from the document language. */
		function labels() {
			const lang = (typeof document !== "undefined" ? document.documentElement.lang : "") || (typeof navigator !== "undefined" ? navigator.language : "") || "";
			if (/^zh/i.test(lang)) {
				return {
					idle: "复制会话路径（供其他会话读取并接续）",
					busy: "正在解析会话路径…",
					copied: "已复制会话路径",
					failed: "复制失败：点开控制台看 [dsh-session-path]",
					menu: "复制会话路径",
					copiedToast: "会话路径已复制",
					failedToast: "复制失败，控制台里搜 [dsh-session-path]",
				};
			}
			return {
				idle: "Copy session path (for another session to read and continue)",
				busy: "Resolving the session path…",
				copied: "Session path copied",
				failed: "Copy failed — see [dsh-session-path] in the console",
				menu: "Copy session path",
				copiedToast: "Session path copied",
				failedToast: "Copy failed — search [dsh-session-path] in the console",
			};
		}
		//#endregion

		//#region header button
		/**
		 * The header button for the open session.
		 * @param props - slot props; `sessionId` identifies the open session.
		 */
		function CopySessionPathButton(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const [phase, setPhase] = useState("idle");
			const timer = useRef(null);
			const t = labels();

			useEffect(
				() => () => {
					if (timer.current !== null) window.clearTimeout(timer.current);
				},
				[],
			);

			const flash = useCallback((next) => {
				if (timer.current !== null) window.clearTimeout(timer.current);
				setPhase(next);
				timer.current = window.setTimeout(() => {
					timer.current = null;
					setPhase("idle");
				}, FEEDBACK_MS);
			}, []);

			const copy = useCallback(async () => {
				if (sessionId === "" || phase === "busy") return;
				setPhase("busy");
				try {
					await copyFor(sessionId);
					flash("copied");
				} catch (error) {
					console.warn("[dsh-session-path] copy failed:", error);
					flash("failed");
				}
			}, [sessionId, phase, flash]);

			if (sessionId === "") return null;
			const title = phase === "copied" ? t.copied : phase === "failed" ? t.failed : phase === "busy" ? t.busy : t.idle;
			return h(
				"button",
				{
					type: "button",
					className: "dshsp_btn",
					"data-phase": phase,
					"data-dsh-session-path": sessionId,
					title,
					"aria-label": title,
					"aria-live": "polite",
					disabled: phase === "busy",
					onClick: copy,
				},
				phase === "copied" ? h(CheckIcon) : phase === "failed" ? h(WarnIcon) : h(CopyIcon),
			);
		}
		//#endregion

		//#region sidebar row menu
		/**
		 * One row of a sidebar session's "..." menu.
		 * @param props - slot props; `sessionId` / `displayTitle` describe the row,
		 *   `useMenuOpenState` is the slot-level hook that dismisses the menu.
		 */
		function CopyPathMenuItem(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const t = labels();
			const onSelect = useCallback(() => {
				try {
					// Dismiss first: a menu left open while the fetch settles would
					// swallow the toast behind it.
					if (typeof props.useMenuOpenState === "function") props.useMenuOpenState()[1](false);
				} catch {
					/* a missing hook must not block the copy */
				}
				if (sessionId === "") return;
				void copyFor(sessionId)
					.then(() => toast(t.copiedToast, true))
					.catch((error) => {
						console.warn("[dsh-session-path] copy failed:", error);
						toast(t.failedToast, false);
					});
			}, [props.useMenuOpenState, sessionId, t]);

			if (sessionId === "") return null;
			if (MenuItemButton !== null) {
				return h(MenuItemButton, { separatorBefore: true, onSelect, "data-dsh-session-path-menu": sessionId }, t.menu);
			}
			return h(
				"button",
				{ type: "button", role: "menuitem", className: "dshsp_menuItem", "data-dsh-session-path-menu": sessionId, onClick: onSelect },
				t.menu,
			);
		}
		//#endregion

		//#region apply
		const inject = ["slots"];

		/**
		 * Register both surfaces.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject(SLOT, () =>
				ctx.slots.register(
					{
						name: SLOT,
						id: "dsh-session-path:copy",
						order: 20,
						inject: () => ({}),
					},
					CopySessionPathButton,
				),
			);
			// Order 500 lands after the shipped Archive (400); `separatorBefore` on
			// the item opens our own group.
			ctx.slots.inject(MENU_SLOT, () =>
				ctx.slots.register(
					{
						name: MENU_SLOT,
						id: "dsh-session-path:copy-session",
						order: 500,
						inject: () => ({}),
					},
					CopyPathMenuItem,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Test seam: the pure pieces `test/selftest.mjs` can exercise. */
		exports.__test__ = { ROUTE, SLOT, MENU_SLOT, labels, writeClipboard };

		return module.exports;
	},
});
