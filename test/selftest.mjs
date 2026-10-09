/**
 * Self-test for dsh-session-path.
 *
 * Runs with a plain `node test/selftest.mjs` — no harness, no network. It covers
 * every module that does not import a host package: the Zstandard frame walker
 * (against a real session log when one exists), session-directory discovery,
 * handoff rendering, the clipboard payload and the HTTP trust fence.
 *
 * `lib/config.js` imports `@deepseek-ai/schemastery`, which only resolves inside
 * a DSH profile; that one module is checked by loading the plugin in a host.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import { composeCopyText } from "../lib/copy-text.js";
import { renderEntries, renderMarkdown, writeHandoff } from "../lib/handoff.js";
import { findSessionDirectory, listSessionLogs, logGeneration, projectDirectoryName, sessionDirectoryNames } from "../lib/paths.js";
import { readSessionRecords, scanZstdFrames } from "../lib/zstd.js";
import { resolveSessionInfo } from "../lib/session-info.js";
import { isTrustedRequest } from "../lib/trust.js";

let passed = 0;
/** Zstandard lives in Node 22.15+/24; older runtimes skip the container checks. */
const HAS_ZSTD = typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function";
/**
 * Run one named check.
 * @param name - check name.
 * @param fn - check body (sync or async).
 */
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

/**
 * A check that needs the synthetic zstd log; skipped (not failed) without zstd.
 * @param name - check name.
 * @param fn - check body.
 */
async function zstdCheck(name, fn) {
	if (!HAS_ZSTD) return;
	await check(name, fn);
}

/** One compressed frame carrying `text`. */
function frame(text) {
	return zlib.zstdCompressSync(Buffer.from(text, "utf8"));
}

/** A synthetic multiple-frame session log: the payload is chunked across frames. */
function syntheticLog(lines) {
	const half = Math.max(1, Math.ceil(lines.length / 2));
	const head = lines.slice(0, half).map((line) => `${line}\n`).join("");
	const tail = lines.slice(half).map((line) => `${line}\n`).join("");
	return Buffer.concat([frame(head), frame(tail)]);
}

const temp = mkdtempSync(join(tmpdir(), "dsh-session-path-"));
const home = join(temp, "dsh-home");
const sessionId = "session-11111111-2222-3333-4444-555555555555";
const cwd = join(temp, "workspace");
const project = join(home, "sessions", projectDirectoryName(cwd));
const sessionDir = join(project, sessionId);
mkdirSync(sessionDir, { recursive: true });

const title = "测试会话标题";
const records = [
	{ type: "session", version: 4, id: sessionId, cwd },
	{ type: "session/title", seq: 1, time: 1, data: { title } },
	{ type: "user/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "第一问" }], source: { kind: "user" } } },
	{ type: "assistant/message", seq: 3, time: 3, data: { message: { role: "assistant", content: [{ type: "reasoning", text: "忽略我" }, { type: "text", text: "第一答" }] } } },
	{ type: "tool/call", seq: 4, time: 4, data: { name: "bash", arguments: '{"command":"ls"}' } },
	{ type: "text-chunks", seq: 5, time: 5, data: { chunks: ["packed"] } },
	{ type: "user/message", seq: 6, time: 6, data: { content: [{ type: "text", text: "第二问" }], source: { kind: "user" } } },
];
const logPath = join(sessionDir, "session.v4.jsonl.zstd");
if (HAS_ZSTD) {
	writeFileSync(logPath, syntheticLog(records.map((record) => JSON.stringify(record))));
	writeFileSync(join(sessionDir, "session.v3.jsonl.zstd"), frame(`${JSON.stringify(records[0])}\n`));
}
writeFileSync(join(sessionDir, "session.lock"), "");

/** A bare context exposing only the home-path service. */
const ctx = { get: (name) => (name === "dshHomePath" ? () => home : undefined) };
const settings = {
	enabled: true,
	copyFormat: "block",
	handoffFormat: "md",
	handoffDir: join(temp, "handoff"),
	maxHandoffChars: 4_000,
	titleScanBytes: 1 << 20,
	promptEnabled: true,
	promptOrder: 64,
};

console.log("zstd container");
await zstdCheck("frames cover the whole synthetic file", () => {
	const buffer = readFileSync(logPath);
	const frames = scanZstdFrames(buffer);
	const covered = frames.reduce((sum, item) => sum + (item.end - item.start), 0);
	assert.ok(frames.length >= 2, `expected >=2 frames, got ${frames.length}`);
	assert.equal(covered, buffer.length, "frames must cover the file exactly");
});
await zstdCheck("a truncated tail frame is ignored, not fatal", () => {
	const buffer = readFileSync(logPath);
	const frames = scanZstdFrames(buffer.subarray(0, buffer.length - 5));
	assert.ok(frames.length >= 1, "the intact prefix must still scan");
});
await zstdCheck("garbage is rejected without throwing", () => {
	assert.deepEqual(scanZstdFrames(Buffer.from("not a zstd stream at all")), []);
});
await zstdCheck("records parse in order and packed rows are dropped", async () => {
	const seen = [];
	for await (const record of readSessionRecords(logPath)) seen.push(record.type);
	assert.deepEqual(seen, ["session", "session/title", "user/message", "assistant/message", "tool/call", "user/message"]);
});
await zstdCheck("maxBytes bounds the read", async () => {
	const seen = [];
	for await (const record of readSessionRecords(logPath, { maxBytes: 12 })) seen.push(record.type);
	assert.ok(seen.length < 7, `expected a bounded read, got ${seen.length} records`);
});

console.log("path discovery");
await zstdCheck("log generations parse and sort numerically", () => {
	assert.deepEqual(logGeneration("session.v10.jsonl.zstd"), { version: 10, compressed: true });
	assert.deepEqual(logGeneration("session.jsonl"), { version: 0, compressed: false });
	assert.equal(logGeneration("session.lock"), null);
	const logs = listSessionLogs(sessionDir);
	assert.equal(logs.length, 2);
	assert.ok(logs[0].endsWith("session.v4.jsonl.zstd"), `newest generation first, got ${logs[0]}`);
});
await check("session directory names cover both spellings", () => {
	assert.deepEqual(sessionDirectoryNames("session-abc"), ["session-abc", "abc"]);
});
await check("findSessionDirectory walks the projects root", () => {
	const found = findSessionDirectory(join(home, "sessions"), sessionId.slice("session-".length));
	assert.equal(found?.dir, sessionDir);
});
await zstdCheck("resolveSessionInfo returns path, cwd and title", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	assert.equal(info.logPath, logPath);
	assert.equal(info.cwd, cwd);
	assert.equal(info.title, title);
	assert.equal(info.exists, true);
});
await check("resolveSessionInfo prefers the live header cwd", async () => {
	const live = { get: (name) => (name === "dshHomePath" ? () => home : name === "sessions" ? { get: () => ({ header: { cwd: "/live/cwd" } }) } : undefined) };
	const info = await resolveSessionInfo(live, settings, sessionId, {});
	assert.equal(info.cwd, "/live/cwd");
	assert.equal(info.logPath, logPath);
});
await check("an unknown session resolves to exists=false", async () => {
	const info = await resolveSessionInfo(ctx, settings, "session-99999999-0000-0000-0000-000000000000", {});
	assert.equal(info.exists, false);
	assert.equal(info.logPath, "");
});

console.log("handoff rendering");
await check("renderEntries keeps the tail and reports truncation", () => {
	const entries = Array.from({ length: 20 }, (_, index) => ({ role: "user", text: `消息 ${index} ${"x".repeat(120)}` }));
	const { body, kept, truncated } = renderEntries(entries, 600);
	assert.ok(kept > 0 && kept < 20, `expected a partial keep, got ${kept}`);
	assert.equal(truncated, true);
	assert.ok(body.includes("消息 19"), "the newest entry must survive");
	assert.ok(!body.includes("消息 0 "), "the oldest entry must be dropped");
});
await check("renderMarkdown carries the header block", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	const entries = [{ role: "user", text: "第一问" }, { role: "assistant", text: "第一答" }, { role: "tool", text: "- `bash` {…}" }];
	const rendered = renderMarkdown(info, entries, 4_000);
	assert.ok(rendered.text.startsWith("# 会话接续记录"));
	assert.ok(rendered.text.includes(`- 会话 ID：${sessionId}`));
	assert.ok(rendered.text.includes("## 用户"));
	assert.ok(rendered.text.includes("第一答"));
	assert.equal(rendered.truncated, false);
});
await zstdCheck("writeHandoff writes a readable markdown file", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	const result = await writeHandoff(ctx, settings, info, {});
	assert.equal(result.format, "md");
	const text = readFileSync(result.file, "utf8");
	assert.ok(text.includes("第一答"), "assistant text must be rendered");
	assert.ok(text.includes("第二问"), "user text must be rendered");
	assert.ok(!text.includes("packed"), "packed rows must never reach the file");
	assert.ok(!text.includes("忽略我"), "reasoning must stay out of the transcript");
	assert.ok(result.chars > 0);
});
await zstdCheck("writeHandoff supports the jsonl format", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	const result = await writeHandoff(ctx, settings, info, { format: "jsonl" });
	const lines = readFileSync(result.file, "utf8").trim().split("\n");
	assert.equal(JSON.parse(lines[0]).type, "session/handoff");
	assert.equal(JSON.parse(lines[1]).id, sessionId);
	assert.ok(!lines.some((line) => line.includes("text-chunks")));
});
await check("writeHandoff refuses a session with no log", async () => {
	const info = await resolveSessionInfo(ctx, settings, "session-99999999-0000-0000-0000-000000000000", {});
	await assert.rejects(() => writeHandoff(ctx, settings, info, {}), /no committed log/);
});

console.log("clipboard payload");
await zstdCheck("block format names the path, the cwd and the continuation tool", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	const text = composeCopyText(info, "block");
	assert.ok(text.includes(logPath));
	assert.ok(text.includes(cwd));
	assert.ok(text.includes("session_handoff"));
	assert.ok(text.includes(title));
});
await zstdCheck("path format is the bare log path", async () => {
	const info = await resolveSessionInfo(ctx, settings, sessionId, {});
	assert.equal(composeCopyText(info, "path"), logPath);
});

console.log("trust fence");
const trusted = ["192.168.0.110:19387"];
await check("loopback hosts pass", () => {
	assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:19387" } }, trusted), true);
	assert.equal(isTrustedRequest({ headers: { host: "localhost:19387" } }, trusted), true);
});
await check("an explicitly trusted authority passes", () => {
	assert.equal(isTrustedRequest({ headers: { host: "192.168.0.110:19387" } }, trusted), true);
});
await check("foreign hosts are rejected", () => {
	assert.equal(isTrustedRequest({ headers: { host: "evil.example.com" } }, trusted), false);
	assert.equal(isTrustedRequest({ headers: {} }, trusted), false);
});
await check("cross-site and mismatched origins are rejected", () => {
	assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "cross-site" } }, trusted), false);
	assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:19387", origin: "http://evil.example.com" } }, trusted), false);
	assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" } }, trusted), true);
});

console.log("real session log (when one exists on this machine)");
await check("the largest real log scans, walks and renders", async () => {
	const { homedir } = await import("node:os");
	const { readdirSync, statSync } = await import("node:fs");
	const root = join(homedir(), ".dsh", "sessions");
	const sizes = [];
	for (const dir of readdirSync(root)) {
		const projectPath = join(root, dir);
		if (!statSync(projectPath).isDirectory()) continue;
		for (const session of readdirSync(projectPath)) {
			const sessionPath = join(projectPath, session);
			if (!statSync(sessionPath).isDirectory()) continue;
			for (const log of listSessionLogs(sessionPath)) sizes.push({ log, size: statSync(log).size });
		}
	}
	if (sizes.length === 0) {
		console.log("      (no session logs on this machine — skipped; run this locally for the real-log pass)");
		return;
	}
	sizes.sort((a, b) => b.size - a.size);
	const largest = sizes[0].log;
	const buffer = readFileSync(largest);
	const frames = scanZstdFrames(buffer);
	const covered = frames.reduce((sum, item) => sum + (item.end - item.start), 0);
	assert.equal(covered, buffer.length, `frames must cover ${largest} exactly`);
	const info = { sessionId: "real", title: "", cwd: "", logPath: largest, dir: "", project: "", root, exists: true };
	const entries = [];
	let seen = 0;
	for await (const record of readSessionRecords(largest)) {
		seen += 1;
		const entry = record.type === "user/message" ? { role: "user", text: "u" } : record.type === "assistant/message" ? { role: "assistant", text: "a" } : null;
		if (entry !== null) entries.push(entry);
	}
	assert.ok(seen > 0, "the largest real log must yield records");
	const rendered = renderMarkdown(info, entries, 4_000);
	assert.ok(rendered.text.startsWith("# 会话接续记录"));
	assert.equal(rendered.truncated, entries.length > 10);
	console.log(`      (${largest}: ${frames.length} frames, ${seen} records, ${entries.length} transcript entries)`);
});

console.log("client bundle structure (the file the web host serves)");
await check("the bundle keeps its loader wrapper, route and both slots", async () => {
	const { fileURLToPath } = await import("node:url");
	const bundle = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	assert.ok(bundle.includes("window.__ModuleLoader__.load("), "must load through the module loader");
	assert.ok(bundle.includes('id: "dsh-session-path"'), "module id must match the package name");
	assert.ok(bundle.includes("/api/dsh-session-path/resolve"), "must call the host route");
	assert.ok(bundle.includes("conversation.session.header.actions"), "header action slot");
	assert.ok(bundle.includes("sidebar.workspaces.session.menu.item"), "sidebar row menu slot");
	assert.ok(bundle.includes("MenuItemButton"), "menu rows reuse the host primitive");
	assert.ok(bundle.includes("navigator.clipboard"), "clipboard write with a legacy fallback");
	assert.ok(!bundle.includes("import "), "Module Loader bundles must not use import statements");
});

rmSync(temp, { recursive: true, force: true });
if (process.exitCode !== undefined && process.exitCode !== 0) {
	console.error(`\n${passed} checks passed, failures above`);
} else {
	console.log(`\n${passed} checks passed`);
}
