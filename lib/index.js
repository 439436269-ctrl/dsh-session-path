/**
 * dsh-session-path — host half.
 *
 * Answers one question: *where does this DSH session live on disk, and how can
 * another session read it?* Two tools (`session_path`, `session_handoff`), one
 * read-only HTTP route for the header button, and a short system-prompt guide.
 *
 * The module only wires things together: configuration lives in `./config.js`,
 * path discovery in `./paths.js`, log decoding in `./zstd.js`, rendering in
 * `./handoff.js`, tool contracts in `./tools.js`, the route in `./route.js`.
 *
 * @module dsh-session-path
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { Config, resolveConfig } from "./config.js";
import { guideText } from "./prompt.js";
import { registerResolveRoute } from "./route.js";
import { createToolSpecs } from "./tools.js";

export const name = "session-path";

export const inject = ["tools", "systemPrompt", "webServer"];

export { Config };

/**
 * Mount the plugin.
 *
 * @param ctx - host plugin context.
 * @param config - loader config (defaults are re-resolved here).
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config);
	if (!settings.enabled) return;

	if (settings.promptEnabled) {
		ctx.systemPrompt.section({
			name: "session-path:guide",
			order: settings.promptOrder,
			text: () => guideText(settings),
		});
	}

	ctx.effect(() => registerResolveRoute(ctx, settings), "dsh-session-path: resolve route");

	for (const spec of createToolSpecs({ ctx, settings })) {
		ctx.tools.register(
			defineTool({
				name: spec.name,
				description: spec.description,
				parameters: spec.parameters,
				output: {
					schema: spec.outputSchema,
					render: spec.render,
				},
				...(spec.presentCall ? { presentCall: spec.presentCall } : {}),
				execute: spec.execute,
			}),
		);
	}
}
