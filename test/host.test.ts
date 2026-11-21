/**
 * The extension driven on the host it is actually running on.
 *
 * The other suites inject a platform so they describe every platform the same
 * way. This one injects nothing: it loads the extension with its real samplers
 * and reads the real `process.platform`, which is the arrangement the operator
 * meets. On a machine with no pressure stall accounting the missing source is
 * ordinary, so nothing may be announced about it, neither through the UI nor
 * through the console.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import loadAwareSteer from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

test("the host's own platform never turns a missing sensor into a complaint", async () => {
	const notifications: string[] = [];
	const statuses: string[] = [];
	const written: string[] = [];
	const handlers = new Map<string, Handler>();

	const original = { error: console.error, log: console.log, warn: console.warn };
	const capture =
		(tag: string) =>
		(...args: unknown[]) => {
			written.push(`[${tag}] ${args.map(String).join(" ")}`);
		};
	console.error = capture("error");
	console.log = capture("log");
	console.warn = capture("warn");

	try {
		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			sendMessage() {},
		};
		const ctx = {
			hasUI: true,
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus(_key: string, value: string) {
					statuses.push(value);
				},
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		loadAwareSteer(pi as never, {});
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "hello", systemPrompt: "", systemPromptOptions: {} },
			ctx,
		);

		const complaints = notifications.filter((message) => /I\/O pressure/.test(message));
		assert.deepEqual(complaints, [], "the host raised an I/O complaint about its own platform");
		assert.deepEqual(
			written.filter((line) => /load-aware-steer/.test(line)),
			[],
			"the host wrote a diagnostic to the console while a UI was attached",
		);

		// The other signals must still produce a footer on this host.
		assert.match(String(statuses.at(-1)), /load .*mem .*swap/);
		if (process.platform !== "linux") {
			assert.match(String(statuses.at(-1)), /io —/, "an unsupported signal shows no figure");
		}
	} finally {
		console.error = original.error;
		console.log = original.log;
		console.warn = original.warn;
	}
});
