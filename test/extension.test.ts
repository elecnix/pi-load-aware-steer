/**
 * The extension factory, driven with injected samplers.
 *
 * These tests hold the machine still: the load and memory values come from
 * variables this file owns, so nothing here depends on what the host happens
 * to be doing while the suite runs.
 *
 * The assertions that matter most are the last two. A monitor that starts
 * telling the agent what to do has stopped being a monitor, so the suite
 * checks that every emitted message is a measurement and that the extension
 * never registers a command or touches a tool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import loadAwareSteer, { type SteerDeps } from "../index.ts";
import type { LoadSample } from "../src/load.ts";
import type { MemorySample } from "../src/memory.ts";
import type { SteerConfig } from "../src/config.ts";

const GIB = 1024 ** 3;

type Sent = { text: string; customType: string; display: boolean; options: Record<string, unknown> };

function loadSample(load1: number): LoadSample {
	return { available: true, load1, load5: load1, load15: load1, source: "os.loadavg" };
}

function unavailableLoad(): LoadSample {
	return { available: false, load1: 0, load5: 0, load15: 0, source: "unavailable", detail: "test: no sensor" };
}

function memorySample(fraction: number): MemorySample {
	const totalBytes = 32 * GIB;
	return {
		available: true,
		totalBytes,
		usedBytes: Math.round(totalBytes * fraction),
		usedFraction: fraction,
		source: "node:os",
	};
}

function testConfig(overrides: Partial<SteerConfig> = {}): SteerConfig {
	return {
		loadThreshold: 4,
		memoryThreshold: 0.8,
		intervalMs: 5,
		enabled: true,
		loadThresholdSource: "default",
		memoryThresholdSource: "default",
		warnings: [],
		elevatedMultiplier: 1,
		highMultiplier: 1.5,
		hysteresis: 0.1,
		...overrides,
	};
}

/** Let the poll interval tick a few times. */
function settle(ms = 40): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(config: SteerConfig) {
	const sent: Sent[] = [];
	const statuses: Array<{ key: string; value: unknown }> = [];
	const notifications: string[] = [];
	const registeredCommands: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

	// Mutable sample box. The test drives the machine by writing here.
	const box = { load1: 0.5, loadAvailable: true, memory: 0.3 };

	const deps: SteerDeps = {
		readLoadImpl: async () => (box.loadAvailable ? loadSample(box.load1) : unavailableLoad()),
		readMemoryImpl: async () => memorySample(box.memory),
		loadConfigImpl: async () => config,
		cpuCountImpl: () => 10,
	};

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		sendMessage(
			message: { customType?: string; content: unknown; display?: boolean },
			options: Record<string, unknown> = {},
		) {
			// Normalised to the shape the assertions read, but the raw fields are
			// captured so a test can check the real customType and display flag.
			sent.push({
				text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
				customType: message.customType ?? "",
				display: message.display ?? false,
				options,
			});
		},
		registerCommand(name: string) {
			registeredCommands.push(name);
			throw new Error("this extension must not register a command");
		},
	};

	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus(key: string, value: unknown) {
				statuses.push({ key, value });
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};

	async function start(): Promise<void> {
		loadAwareSteer(pi as never, deps);
		await handlers.get("session_start")?.({}, ctx);
		await settle();
	}

	async function stop(): Promise<void> {
		await handlers.get("session_shutdown")?.({}, ctx);
	}

	return { box, sent, statuses, notifications, registeredCommands, handlers, start, stop, config };
}

/** Every imperative a monitor must never use to address the agent. */
const DIRECTIVE_PATTERN =
	/\b(stop|halt|avoid|prefer|should|shouldn't|must|wait|pause|defer|delay|reduce|limit|consider|please|try|instead|recommend|suggest|ensure|make sure)\b/i;

test("a quiet machine produces no conversation message at all", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	assert.equal(h.sent.length, 0, "nothing to report means nothing is injected");
	await h.stop();
});

test("crossing a load threshold injects exactly one message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5; // threshold 4
	await settle();

	assert.equal(h.sent.length, 1, "one crossing, one message");
	await h.stop();
});

test("a message is delivered without interrupting or triggering a turn", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	await settle();

	const message = h.sent[0];
	assert.ok(message, "expected a message");
	assert.equal(message.customType, "load-aware-steer.update", "messages are tagged by this extension");
	assert.equal(message.display, true, "the reader should see the message, not just the model");
	assert.equal(message.options.deliverAs, "nextTurn", "must be deferred to the next turn");
	assert.equal(message.options.triggerTurn, false, "must not start a turn");
	await h.stop();
});

test("a message reports load, CPU count, and memory used of total", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	h.box.memory = 0.5;
	await settle();

	const text = h.sent[0]?.text ?? "";
	assert.match(text, /Load average/, "reports load");
	assert.match(text, /\d+\.\d+ \(1 min\)/, "reports the one-minute average");
	assert.match(text, /10 logical CPUs/, "reports the CPU count");
	assert.match(text, /Memory:/, "reports memory");
	assert.match(text, /16\.0 GiB of 32\.0 GiB/, "reports memory used of total");
	assert.match(text, /50%/, "reports memory as a percentage");
	await h.stop();
});

test("a message names the band change in both directions", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	await settle();
	assert.match(h.sent[0].text, /Band normal -> elevated/);

	h.box.load1 = 0.5;
	await settle();
	assert.match(h.sent[1].text, /Band elevated -> normal/, "a recovering machine is reported too");
	await h.stop();
});

test("a memory crossing is reported on its own", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.memory = 0.9; // threshold 0.8
	await settle();

	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0].text, /Memory:/);
	assert.match(h.sent[0].text, /Band normal -> elevated/);
	await h.stop();
});

test("a message never tells the agent what to do", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	// Walk both signals up through every band and back down again.
	for (const load of [0.5, 5, 9, 0.5]) {
		h.box.load1 = load;
		h.box.memory = 0.9;
		await settle(15);
	}
	for (const memory of [0.9, 0.3]) {
		h.box.memory = memory;
		await settle(15);
	}

	assert.ok(h.sent.length >= 3, `expected several messages, got ${h.sent.length}`);
	for (const message of h.sent) {
		const offending = message.text.match(DIRECTIVE_PATTERN);
		assert.equal(
			offending,
			null,
			`message addresses the agent with "${offending?.[0]}":\n${message.text}`,
		);
	}
	await h.stop();
});

test("a value inside the hysteresis margin produces no message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5; // engages elevated at 4
	await settle();
	assert.equal(h.sent.length, 1);

	// 3.7 is below the entry point of 4 but above the 3.6 release point.
	h.box.load1 = 3.7;
	await settle(30);
	assert.equal(h.sent.length, 1, "a dip inside the margin is not a crossing");
	await h.stop();
});

test("a dead sensor holds its band instead of announcing a recovery", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	await settle();
	assert.equal(h.sent.length, 1);

	// If missing data read as "quiet" this would announce a false recovery.
	h.box.loadAvailable = false;
	await settle(30);
	assert.equal(h.sent.length, 1, "unavailable data must not move the band");

	h.box.loadAvailable = true;
	h.box.load1 = 0.5;
	await settle(30);
	assert.equal(h.sent.length, 2, "the real recovery is reported once the sensor returns");
	await h.stop();
});

test("a disabled extension samples but stays silent", async () => {
	const h = makeHarness(testConfig({ enabled: false }));
	await h.start();

	h.box.load1 = 50;
	h.box.memory = 0.99;
	await settle();

	assert.equal(h.sent.length, 0);
	assert.ok(h.statuses.length > 0, "the status line still updates");
	await h.stop();
});

test("an unreachable threshold keeps the extension quiet", async () => {
	const h = makeHarness(testConfig({ loadThreshold: 1_000_000, memoryThreshold: 0.999999 }));
	await h.start();

	h.box.load1 = 20;
	h.box.memory = 0.9;
	await settle();

	assert.equal(h.sent.length, 0, "no crossing, no message");
	await h.stop();
});

test("the extension registers no command", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	assert.deepEqual(h.registeredCommands, []);
	await h.stop();
});

test("shutdown stops sampling", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.stop();

	const before = h.sent.length;
	h.box.load1 = 50;
	h.box.memory = 0.95;
	await settle(40);

	assert.equal(h.sent.length, before, "no polling after shutdown");
});
