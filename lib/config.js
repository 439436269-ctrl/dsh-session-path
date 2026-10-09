/**
 * Plugin configuration: the schema the host validates against, the code-side
 * defaults (so a direct `apply()` call works without the loader), and the
 * normalisation of every string/enum knob.
 *
 * The Cordis loader applies `Config` defaults, but `apply` is also reachable
 * through direct construction (tests, tooling), so this module resolves its own
 * defaults instead of trusting the caller.
 *
 * @module dsh-session-path/config
 */

import z from "@deepseek-ai/schemastery";

/** Code-side defaults, mirrored by the `Config` schema below. */
export const DEFAULTS = Object.freeze({
	enabled: true,
	copyFormat: "block",
	handoffFormat: "md",
	handoffDir: "",
	maxHandoffChars: 200_000,
	titleScanBytes: 2_097_152,
	promptEnabled: true,
	promptOrder: 64,
});

export const Config = z.object({
	/** Master switch; `false` registers no tools and no HTTP route. */
	enabled: z.boolean().default(DEFAULTS.enabled),
	/** Clipboard payload shape for the header button: `block` or `path`. */
	copyFormat: z.string().default(DEFAULTS.copyFormat),
	/** `session_handoff` output format: `md` (transcript) or `jsonl` (events). */
	handoffFormat: z.string().default(DEFAULTS.handoffFormat),
	/** Directory for handoff files; empty means `$DSH_HOME/session-handoff`. */
	handoffDir: z.string().default(DEFAULTS.handoffDir),
	/** Character budget for one handoff file (the tail of the session wins). */
	maxHandoffChars: z.natural().default(DEFAULTS.maxHandoffChars),
	/** Compressed bytes scanned when the log title must be read from disk. */
	titleScanBytes: z.natural().default(DEFAULTS.titleScanBytes),
	/** Whether to contribute the guide section to the system prompt. */
	promptEnabled: z.boolean().default(DEFAULTS.promptEnabled),
	/** Ordering of that system-prompt section. */
	promptOrder: z.natural().default(DEFAULTS.promptOrder),
});

/**
 * One of `allowed`, or `fallback` when the value is absent/unknown.
 *
 * @param value - raw configured value.
 * @param allowed - accepted strings.
 * @param fallback - value used otherwise.
 * @returns the resolved string.
 */
function pick(value, allowed, fallback) {
	return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

/**
 * A positive integer, or `fallback`.
 *
 * @param value - raw configured value.
 * @param fallback - value used otherwise.
 * @returns the resolved integer.
 */
function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * Resolve user configuration into the plain settings object the plugin uses.
 *
 * @param raw - the loader-supplied config (possibly undefined).
 * @returns resolved settings.
 */
export function resolveConfig(raw) {
	const config = raw === null || typeof raw !== "object" ? {} : raw;
	return {
		enabled: config.enabled !== false,
		copyFormat: pick(config.copyFormat, ["block", "path"], DEFAULTS.copyFormat),
		handoffFormat: pick(config.handoffFormat, ["md", "jsonl"], DEFAULTS.handoffFormat),
		handoffDir: typeof config.handoffDir === "string" ? config.handoffDir.trim() : "",
		maxHandoffChars: positiveInteger(config.maxHandoffChars, DEFAULTS.maxHandoffChars),
		titleScanBytes: positiveInteger(config.titleScanBytes, DEFAULTS.titleScanBytes),
		promptEnabled: config.promptEnabled !== false,
		promptOrder: Number.isSafeInteger(Number(config.promptOrder)) ? Number(config.promptOrder) : DEFAULTS.promptOrder,
	};
}
