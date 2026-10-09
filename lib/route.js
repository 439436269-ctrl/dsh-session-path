/**
 * The one HTTP route the browser half needs: resolve a session id into its log
 * path and a paste-ready copy payload.
 *
 * Registration rides the injected fiber, so unloading the plugin withdraws the
 * route. The route is read-only — it never writes a handoff file (that is the
 * `session_handoff` tool's job, so file creation stays a deliberate agent act).
 *
 * @module dsh-session-path/route
 */

import { composeCopyText } from "./copy-text.js";
import { resolveSessionInfo } from "./session-info.js";
import { isTrustedRequest } from "./trust.js";

/** Exact path served by this plugin. */
export const RESOLVE_ROUTE = "/api/dsh-session-path/resolve";

/**
 * Write one JSON envelope.
 *
 * @param res - HTTP response.
 * @param status - status code.
 * @param body - JSON-serialisable body.
 */
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/**
 * Register the resolve route.
 *
 * @param ctx - host plugin context.
 * @param settings - resolved plugin settings.
 * @returns a disposer (no-op when the host has no web server).
 */
export function registerResolveRoute(ctx, settings) {
	const server = ctx.get("webServer");
	if (server === undefined || typeof server.register !== "function") return () => {};
	const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
	return server.register({
		kind: "exact",
		path: RESOLVE_ROUTE,
		handler: async (req, res) => {
			if (!isTrustedRequest(req, trustedHosts)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			let params;
			try {
				params = new URL(req.url ?? RESOLVE_ROUTE, "http://localhost").searchParams;
			} catch {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "malformed request url" } });
				return;
			}
			const sessionId = params.get("sessionId") ?? "";
			if (sessionId === "") {
				writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
				return;
			}
			try {
				const info = await resolveSessionInfo(ctx, settings, sessionId, {
					title: params.get("title") ?? "",
					cwd: params.get("cwd") ?? "",
				});
				writeJson(res, 200, {
					ok: true,
					value: {
						sessionId: info.sessionId,
						title: info.title,
						cwd: info.cwd,
						logPath: info.logPath,
						dir: info.dir,
						exists: info.exists,
						copyFormat: settings.copyFormat,
						text: composeCopyText(info, settings.copyFormat),
					},
				});
			} catch (error) {
				writeJson(res, 500, {
					ok: false,
					error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
				});
			}
		},
	});
}
