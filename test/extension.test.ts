/**
 * The extension factory, driven with injected samplers.
 *
 * These tests fix the machine's state: the load and memory values come from
 * variables this file owns, so nothing here depends on what the host is doing
 * while the suite runs.
 *
 * The extension samples at two turn boundaries and nowhere else: when a user
 * prompt starts an agent run (`before_agent_start`) and when a turn that ran
 * tools ends (`turn_end`). The harness calls those handlers directly, the way
 * pi does, and counts sampler calls to prove that nothing samples in between.
 *
 * A monitor that starts telling the agent what to do has stopped being a
 * monitor, so the suite also checks that every message is a measurement and
 * that the extension never registers a command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import loadAwareSteer, { type SteerDeps } from "../index.ts";
import type { LoadSample } from "../src/load.ts";
import type { MemorySample } from "../src/memory.ts";
import type { SteerConfig } from "../src/config.ts";

const GIB = 1024 ** 3;

type Handler = (event: unknown, ctx: unknown) => unknown;

type PromptMessage = { customType: string; content: string; display: boolean };
type PromptResult = { message?: PromptMessage; systemPrompt?: string } | undefined;

type Draft = { type: string; customType?: string; content?: string; display?: boolean };
type TurnEndResult = { entries?: Draft[]; continue?: boolean } | undefined;

function loadSample(load1: number): LoadSample {
	return { available: true, load1, load5: load1 * 0.8, load15: load1 * 0.6, source: "os.loadavg" };
}

function unavailableLoad(): LoadSample {
	return { available: false, load1: 0, load5: 0, load15: 0, source: "unavailable", detail: "test: no sensor" };
}

function memorySample(fraction: number, source: MemorySample["source"] = "node:os"): MemorySample {
	const totalBytes = 32 * GIB;
	return {
		available: true,
		totalBytes,
		usedBytes: Math.round(totalBytes * fraction),
		usedFraction: fraction,
		source,
	};
}

function testConfig(overrides: Partial<SteerConfig> = {}): SteerConfig {
	return {
		loadThreshold: 4,
		memoryThreshold: 0.8,
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHarness(config: SteerConfig) {
	const sent: unknown[] = [];
	const statuses: Array<{ key: string; value: unknown }> = [];
	const notifications: string[] = [];
	const registeredCommands: string[] = [];
	const handlers = new Map<string, Handler>();

	// The test drives the machine by writing to this object.
	const box = { load1: 0.5, loadAvailable: true, memory: 0.3, memorySource: "node:os" as MemorySample["source"] };
	const calls = { load: 0, memory: 0 };

	const deps: SteerDeps = {
		readLoadImpl: async () => {
			calls.load++;
			return box.loadAvailable ? loadSample(box.load1) : unavailableLoad();
		},
		readMemoryImpl: async () => {
			calls.memory++;
			return memorySample(box.memory, box.memorySource);
		},
		loadConfigImpl: async () => config,
		cpuCountImpl: () => 10,
	};

	const pi = {
		on(event: string, handler: Handler) {
			assert.ok(!handlers.has(event), `handler for ${event} registered twice`);
			handlers.set(event, handler);
		},
		sendMessage(message: unknown) {
			sent.push(message);
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

	loadAwareSteer(pi as never, deps);

	async function start(): Promise<void> {
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	}

	async function stop(): Promise<void> {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	}

	/** A user prompt starting an agent run. */
	async function prompt(): Promise<PromptResult> {
		const handler = handlers.get("before_agent_start");
		assert.ok(handler, "before_agent_start handler registered");
		return (await handler(
			{ type: "before_agent_start", prompt: "hello", systemPrompt: "", systemPromptOptions: {} },
			ctx,
		)) as PromptResult;
	}

	/** The end of one turn inside an agent run. */
	async function turnEnd(
		options: { toolResults?: number; outcome?: "completed" | "aborted" | "error"; entries?: Draft[] } = {},
	): Promise<TurnEndResult> {
		const handler = handlers.get("turn_end");
		assert.ok(handler, "turn_end handler registered");
		const toolResults = Array.from({ length: options.toolResults ?? 1 }, (_, index) => ({
			role: "toolResult",
			toolCallId: `call-${index}`,
		}));
		return (await handler(
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant" },
				toolResults,
				messageEntryId: "assistant-entry",
				toolResultEntryIds: toolResults.map((_, index) => `tool-entry-${index}`),
				entries: options.entries ?? [],
				continue: false,
				context: { canContinue: toolResults.length > 0 },
				outcome: options.outcome ?? "completed",
			},
			ctx,
		)) as TurnEndResult;
	}

	return {
		box,
		calls,
		sent,
		statuses,
		notifications,
		registeredCommands,
		handlers,
		start,
		stop,
		prompt,
		turnEnd,
	};
}

/** Every imperative a monitor must never use to address the agent. */
const DIRECTIVE_PATTERN =
	/\b(stop|halt|avoid|prefer|should|shouldn't|must|wait|pause|defer|delay|reduce|limit|consider|please|try|instead|recommend|suggest|ensure|make sure)\b/i;

/** The custom_message drafts this extension appended at a turn_end. */
function appended(result: TurnEndResult): Draft[] {
	return (result?.entries ?? []).filter((entry) => entry.customType === "load-aware-steer.update");
}

test("session start samples nothing and reports nothing", async () => {
	const h = makeHarness(testConfig());
	h.box.load1 = 50;
	h.box.memory = 0.99;
	await h.start();

	assert.equal(h.calls.load + h.calls.memory, 0, "a session that never prompts is never sampled");
	assert.equal(h.sent.length, 0);
	await h.stop();
});

test("a quiet machine adds nothing to the prompt", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	const result = await h.prompt();
	assert.equal(result?.message, undefined, "nothing to report means nothing is injected");
	assert.equal(h.calls.load, 1, "the prompt took one sample");
	await h.stop();
});

test("a crossing at a prompt is returned as one custom message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5; // threshold 4
	const result = await h.prompt();

	const message = result?.message;
	assert.ok(message, "expected a message");
	assert.equal(message.customType, "load-aware-steer.update", "messages are tagged by this extension");
	assert.equal(message.display, true, "the reader should see the message, not just the model");
	assert.equal(result.systemPrompt, undefined, "the system prompt is left alone");
	assert.equal(h.sent.length, 0, "sendMessage is never used, so nothing can queue up");
	await h.stop();
});

test("load and memory crossing in one sample produce one message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	h.box.memory = 0.9;
	const result = await h.prompt();

	const text = result?.message?.content ?? "";
	assert.equal(text.match(/System resource update/g)?.length, 1, "one message, not one per signal");
	assert.match(text, /Load average:.*Band normal -> elevated\./, "the load line names its change");
	assert.match(text, /Memory:.*Band normal -> elevated\./, "the memory line names its change");
	assert.equal(h.sent.length, 0);
	await h.stop();
});

test("a message reports load, CPU count, and memory used of total", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	h.box.memory = 0.5;
	const text = (await h.prompt())?.message?.content ?? "";

	assert.match(text, /5\.00 \(1 min\), 4\.00 \(5 min\), 3\.00 \(15 min\)/, "reports all three averages");
	assert.match(text, /10 logical CPUs/, "reports the CPU count");
	assert.match(text, /16\.0 GiB of 32\.0 GiB in use \(50%\)/, "reports memory used of total");
	assert.match(text, /Memory:.*band normal\./, "an unchanged signal shows its current band");
	await h.stop();
});

test("a memory sample from vm_stat reports the same figures as one from os.freemem", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 0.5;
	h.box.memory = 0.9;
	h.box.memorySource = "node:os";
	const naive = (await h.prompt())?.message?.content ?? "";

	h.box.memory = 0.4;
	h.box.memorySource = "vm_stat";
	const accurate = (await h.prompt())?.message?.content ?? "";

	// The source changes the number, not the shape of the report: the reader
	// sees the same sentence with the figures the sampler produced.
	assert.match(naive, /28\.8 GiB of 32\.0 GiB in use \(90%\)/, "the naive sample reports its own figure");
	assert.match(accurate, /12\.8 GiB of 32\.0 GiB in use \(40%\)/, "the vm_stat sample reports its own figure");
	assert.match(accurate, /Memory:.*Band elevated -> normal\./, "the band steps down as the figure falls");
	await h.stop();
});

test("a band change is reported in both directions", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	assert.match((await h.prompt())?.message?.content ?? "", /Band normal -> elevated/);

	h.box.load1 = 0.5;
	assert.match(
		(await h.prompt())?.message?.content ?? "",
		/Band elevated -> normal/,
		"a recovering machine is reported too",
	);
	await h.stop();
});

test("an unchanged band is not reported again", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	assert.ok((await h.prompt())?.message);
	assert.equal((await h.prompt())?.message, undefined, "the same band at the next prompt is not news");
	await h.stop();
});

test("nothing samples while the agent is idle", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();
	const after = { ...h.calls };

	h.box.load1 = 50;
	h.box.memory = 0.99;
	await delay(50);

	assert.deepEqual(h.calls, after, "no timer samples between prompts");
	assert.equal(h.sent.length, 0, "nothing queues up for the next prompt");
	await h.stop();
});

test("a crossing between tool turns is appended as one entry at turn_end", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();

	h.box.load1 = 5;
	h.box.memory = 0.9;
	const result = await h.turnEnd({ toolResults: 2 });

	const drafts = appended(result);
	assert.equal(drafts.length, 1, "one entry for both signals");
	assert.equal(drafts[0].type, "custom_message", "a context message, not a hidden custom entry");
	assert.equal(drafts[0].display, true);
	assert.match(drafts[0].content ?? "", /Load average:.*Band normal -> elevated/);
	assert.match(drafts[0].content ?? "", /Memory:.*Band normal -> elevated/);
	assert.equal(result?.continue, undefined, "never asks pi for another turn");
	assert.equal(h.sent.length, 0);
	await h.stop();
});

test("turn_end keeps entries that other extensions appended", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();

	h.box.load1 = 5;
	const other: Draft = { type: "custom", customType: "other-extension.state" };
	const result = await h.turnEnd({ entries: [other] });

	assert.deepEqual(result?.entries?.[0], other, "the earlier entry comes first, unchanged");
	assert.equal(result?.entries?.length, 2);
	await h.stop();
});

test("turn_end without a crossing leaves the entries alone", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();

	const result = await h.turnEnd();
	assert.equal(result?.entries, undefined, "nothing to report means the entry list is not replaced");
	assert.equal(result?.continue, undefined);
	await h.stop();
});

test("the last turn of a run takes no sample", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();
	const after = { ...h.calls };

	h.box.load1 = 50;
	const result = await h.turnEnd({ toolResults: 0 });

	assert.equal(result, undefined, "a turn with no tool results ends the run, so nothing follows it");
	assert.deepEqual(h.calls, after, "no sample is taken");
	await h.stop();
});

test("an aborted or failed turn takes no sample", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();
	const after = { ...h.calls };

	h.box.load1 = 50;
	assert.equal(await h.turnEnd({ outcome: "aborted" }), undefined);
	assert.equal(await h.turnEnd({ outcome: "error" }), undefined);
	assert.deepEqual(h.calls, after);
	await h.stop();
});

test("a crossing reported at turn_end is not repeated at the next prompt", async () => {
	const h = makeHarness(testConfig());
	await h.start();
	await h.prompt();

	h.box.load1 = 5;
	assert.equal(appended(await h.turnEnd()).length, 1);
	assert.equal((await h.prompt())?.message, undefined, "the band was already reported");
	await h.stop();
});

test("a message never tells the agent what to do", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	const texts: string[] = [];
	// Walk both signals up through every band and back down again.
	for (const [load, memory] of [
		[5, 0.9],
		[9, 0.95],
		[0.5, 0.9],
		[0.5, 0.3],
		[0.5, 0.3],
	]) {
		h.box.load1 = load;
		h.box.memory = memory;
		const fromPrompt = (await h.prompt())?.message?.content;
		if (fromPrompt) texts.push(fromPrompt);
		h.box.load1 = load * 2;
		for (const draft of appended(await h.turnEnd())) texts.push(draft.content ?? "");
	}

	assert.ok(texts.length >= 4, `expected several messages, got ${texts.length}`);
	for (const text of texts) {
		const offending = text.match(DIRECTIVE_PATTERN);
		assert.equal(offending, null, `message addresses the agent with "${offending?.[0]}":\n${text}`);
	}
	await h.stop();
});

test("a value inside the hysteresis margin produces no message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5; // enters elevated at 4
	assert.ok((await h.prompt())?.message);

	// 3.7 is below the entry point of 4 but above the 3.6 release point.
	h.box.load1 = 3.7;
	assert.equal((await h.prompt())?.message, undefined, "a dip inside the margin is not a crossing");
	await h.stop();
});

test("a dead sensor leaves its band unchanged", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	assert.ok((await h.prompt())?.message);

	// If missing data read as "quiet" this would report a false recovery.
	h.box.loadAvailable = false;
	assert.equal((await h.prompt())?.message, undefined, "unavailable data must not move the band");

	h.box.loadAvailable = true;
	h.box.load1 = 0.5;
	assert.match(
		(await h.prompt())?.message?.content ?? "",
		/Band elevated -> normal/,
		"the real recovery is reported once the sensor returns",
	);
	await h.stop();
});

test("a dead sensor is left out of the message", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.loadAvailable = false;
	h.box.memory = 0.9;
	const text = (await h.prompt())?.message?.content ?? "";

	assert.match(text, /Memory:.*Band normal -> elevated/);
	assert.doesNotMatch(text, /Load average/, "a signal with no reading has no line");
	assert.equal(h.sent.length, 0, "sendMessage is never used");
	await h.stop();
});

test("a disabled extension samples but stays silent", async () => {
	const h = makeHarness(testConfig({ enabled: false }));
	await h.start();

	h.box.load1 = 50;
	h.box.memory = 0.99;
	assert.equal((await h.prompt())?.message, undefined);
	assert.equal(await h.turnEnd(), undefined);
	assert.ok(h.statuses.length > 0, "the status line still updates");
	await h.stop();
});

test("an unreachable threshold keeps the extension quiet", async () => {
	const h = makeHarness(testConfig({ loadThreshold: 1_000_000, memoryThreshold: 0.999999 }));
	await h.start();

	h.box.load1 = 20;
	h.box.memory = 0.9;
	assert.equal((await h.prompt())?.message, undefined, "no crossing, no message");
	await h.stop();
});

test("the status line shows the latest sample", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 2.5;
	h.box.memory = 0.5;
	await h.prompt();

	const last = h.statuses.at(-1);
	assert.equal(last?.key, "load-aware-steer");
	assert.equal(last?.value, "load 2.50/10 · mem 50%");
	await h.stop();
});

test("the extension registers turn boundary handlers and no command", async () => {
	const h = makeHarness(testConfig());
	assert.deepEqual(
		[...h.handlers.keys()].sort(),
		["before_agent_start", "session_shutdown", "session_start", "turn_end"],
	);
	assert.deepEqual(h.registeredCommands, []);
});

test("shutdown clears the status line and a new session starts from normal", async () => {
	const h = makeHarness(testConfig());
	await h.start();

	h.box.load1 = 5;
	assert.ok((await h.prompt())?.message);
	await h.stop();
	assert.deepEqual(h.statuses.at(-1), { key: "load-aware-steer", value: undefined });

	await h.start();
	assert.match(
		(await h.prompt())?.message?.content ?? "",
		/Band normal -> elevated/,
		"a new session reports the current band again",
	);
	await h.stop();
});
