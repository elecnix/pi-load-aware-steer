/**
 * load-aware-steer
 *
 * Watches two signals on this machine — 1-minute load average and physical
 * memory in use — and puts a number in the conversation when one of them
 * changes band.
 *
 * It reports. It does not steer. There is no system-prompt nudge, no tool
 * block, no command deferral, and no registered command. The only thing this
 * extension ever does is sample two numbers, keep a status line current, and
 * append a factual message to the conversation when a band changes.
 *
 * Sampling happens at two turn boundaries and nowhere else: when a user
 * prompt starts an agent run (`before_agent_start`) and when a turn that ran
 * tools ends (`turn_end`). There is no timer. While the agent sits idle at a
 * prompt waiting for the human, nothing is sampled and nothing accumulates.
 *
 * Messages never interrupt: `before_agent_start` returns the message as its
 * result and `turn_end` appends it as a draft entry alongside whatever other
 * extensions appended, without setting `continue`.
 *
 * Band changes are reported in both directions, so a machine recovering is as
 * visible as one saturating. Hysteresis keeps a value hovering at a boundary
 * from producing a message at every sample.
 *
 * Loaded via jiti, so TypeScript needs no build step.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

import { readLoad, type LoadSample } from "./src/load.ts";
import { readMemory, formatBytes, type MemorySample } from "./src/memory.ts";
import { nextBand, isCrossing, type Band } from "./src/signals.ts";
import { loadConfig, cpuCount, type SteerConfig } from "./src/config.ts";

const STATUS_KEY = "load-aware-steer";
const MESSAGE_TYPE = "load-aware-steer.update";

/** Identifies which of the two signals a band belongs to. */
type Signal = "load" | "memory";

type State = {
	config: SteerConfig | null;
	load: LoadSample | null;
	memory: MemorySample | null;
	loadBand: Band;
	memoryBand: Band;
	cpus: number;
	/** One-shot guards so a broken sensor reports once per session, not per boundary. */
	loadUnavailableNotified: boolean;
	memoryUnavailableNotified: boolean;
	configWarned: boolean;
};

function makeState(): State {
	return {
		config: null,
		load: null,
		memory: null,
		loadBand: "normal",
		memoryBand: "normal",
		cpus: cpuCount(),
		loadUnavailableNotified: false,
		memoryUnavailableNotified: false,
		configWarned: false,
	};
}

function debugEnabled(): boolean {
	return process.env.LOAD_AWARE_STEER_DEBUG === "1";
}

function loadText(sample: LoadSample | null): string {
	if (!sample) return "not sampled yet";
	if (!sample.available) return `unavailable (${sample.detail ?? "unknown reason"})`;
	return `${sample.load1.toFixed(2)} / ${sample.load5.toFixed(2)} / ${sample.load15.toFixed(2)}`;
}

function memoryText(sample: MemorySample | null): string {
	if (!sample) return "not sampled yet";
	if (!sample.available) return `unavailable (${sample.detail ?? "unknown reason"})`;
	return `${formatBytes(sample.usedBytes)} / ${formatBytes(sample.totalBytes)} (${(sample.usedFraction * 100).toFixed(0)}%)`;
}

/**
 * Compose the one combined message for this sample.
 *
 * Every sentence is a measurement or a statement about which band changed.
 * There is no imperative anywhere in this function, and that is the point:
 * the reader gets the numbers and draws their own conclusion.
 */
function formatCombinedReport(
	changes: Array<{ signal: Signal; previous: Band; next: Band }>,
	state: State,
): string {
	const lines: string[] = ["System resource update. Measurements only."];

	for (const change of changes) {
		if (change.signal === "load" && state.load?.available) {
			lines.push(
				`Load average: ${state.load.load1.toFixed(2)} (1 min), ${state.load.load5.toFixed(2)} (5 min), ` +
					`${state.load.load15.toFixed(2)} (15 min) on ${state.cpus} logical CPUs. ` +
					`Band ${change.previous} -> ${change.next}.`,
			);
		}
		if (change.signal === "memory" && state.memory?.available) {
			lines.push(
				`Memory: ${formatBytes(state.memory.usedBytes)} of ${formatBytes(state.memory.totalBytes)} in use ` +
					`(${(state.memory.usedFraction * 100).toFixed(0)}%). Band ${change.previous} -> ${change.next}.`,
			);
		}
	}

	// Mention any signal that did not change, so one message carries the full
	// picture. A signal without a reading gets no line at all, rather than a
	// line describing what it does not have.
	if (!changes.some((change) => change.signal === "load") && state.load?.available) {
		lines.push(
			`Load average: ${state.load.load1.toFixed(2)} (1 min) on ${state.cpus} logical CPUs, band ${state.loadBand}.`,
		);
	}
	if (!changes.some((change) => change.signal === "memory") && state.memory?.available) {
		lines.push(
			`Memory: ${formatBytes(state.memory.usedBytes)} of ${formatBytes(state.memory.totalBytes)} in use ` +
				`(${(state.memory.usedFraction * 100).toFixed(0)}%), band ${state.memoryBand}.`,
		);
	}

	return lines.join("\n");
}

/** Keep the footer status current. Presentation only, no thresholds implied. */
function updateStatus(ctx: ExtensionContext, state: State): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const load = state.load?.available ? state.load.load1.toFixed(2) : "—";
	const memory = state.memory?.available ? `${(state.memory.usedFraction * 100).toFixed(0)}%` : "—";
	const label = `load ${load}/${state.cpus} · mem ${memory}`;

	const worst: Band =
		state.loadBand === "high" || state.memoryBand === "high"
			? "high"
			: state.loadBand === "elevated" || state.memoryBand === "elevated"
				? "elevated"
				: "normal";
	const painted =
		worst === "high"
			? theme?.fg("error", label)
			: worst === "elevated"
				? theme?.fg("warning", label)
				: theme?.fg("dim", label);

	ctx.ui.setStatus(STATUS_KEY, painted ?? label);
}

export type SteerDeps = {
	/** Injected for tests. Defaults to the real sampler. */
	readLoadImpl?: () => Promise<LoadSample>;
	readMemoryImpl?: () => Promise<MemorySample>;
	loadConfigImpl?: typeof loadConfig;
	cpuCountImpl?: () => number;
};

export type ResolvedDeps = Required<SteerDeps>;

function resolveDeps(deps: SteerDeps): ResolvedDeps {
	return {
		readLoadImpl: deps.readLoadImpl ?? readLoad,
		readMemoryImpl: deps.readMemoryImpl ?? readMemory,
		loadConfigImpl: deps.loadConfigImpl ?? loadConfig,
		cpuCountImpl: deps.cpuCountImpl ?? cpuCount,
	};
}

/**
 * The single sampling step both boundaries share.
 *
 * Takes one sample of both sensors, moves each band through the state
 * machine, and returns the text of one combined message if at least one band
 * crossed. Callers choose how to deliver the text: as the before_agent_start
 * result, or as a turn_end draft entry.
 */
async function sampleAndReport(
	ctx: ExtensionContext,
	state: State,
	deps: ResolvedDeps,
): Promise<string | null> {
	const config = state.config;
	if (!config) return null;

	const [load, memory] = await Promise.all([deps.readLoadImpl(), deps.readMemoryImpl()]);
	state.load = load;
	state.memory = memory;

	// An unavailable sensor is surfaced where the user can see it, once, and
	// its band holds until the sensor returns.
	if (!load.available && !state.loadUnavailableNotified) {
		state.loadUnavailableNotified = true;
		if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: load average unavailable (${load.detail}).`, "warning");
		console.error(`[load-aware-steer] load unavailable: ${load.detail}`);
	}
	if (!memory.available && !state.memoryUnavailableNotified) {
		state.memoryUnavailableNotified = true;
		if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: memory unavailable (${memory.detail}).`, "warning");
		console.error(`[load-aware-steer] memory unavailable: ${memory.detail}`);
	}

	updateStatus(ctx, state);

	if (!config.enabled) return null;

	const changes: Array<{ signal: Signal; previous: Band; next: Band }> = [];

	if (load.available) {
		const previous = state.loadBand;
		const next = nextBand(previous, load.load1, config.loadThreshold, config);
		if (isCrossing(previous, next)) {
			changes.push({ signal: "load", previous, next });
			state.loadBand = next;
		}
	}

	if (memory.available) {
		const previous = state.memoryBand;
		const next = nextBand(previous, memory.usedFraction, config.memoryThreshold, config);
		if (isCrossing(previous, next)) {
			changes.push({ signal: "memory", previous, next });
			state.memoryBand = next;
		}
	}

	if (changes.length === 0) return null;

	if (debugEnabled()) {
		for (const change of changes) {
			console.error(`[load-aware-steer] ${change.signal} ${change.previous} -> ${change.next}`);
		}
	}
	return formatCombinedReport(changes, state);
}

async function beforeAgentStart(
	ctx: ExtensionContext,
	state: State,
	deps: ResolvedDeps,
	_event: BeforeAgentStartEvent,
): Promise<BeforeAgentStartEventResult | undefined> {
	const report = await sampleAndReport(ctx, state, deps);
	if (!report) return undefined;
	return {
		message: {
			customType: MESSAGE_TYPE,
			content: report,
			// Shown in the transcript: the point of the message is that the
			// reader sees it, not just that the model does.
			display: true,
		},
	};
}

async function turnEnd(
	ctx: ExtensionContext,
	state: State,
	deps: ResolvedDeps,
	event: TurnEndEvent,
): Promise<TurnEndEventResult | undefined> {
	// A turn whose assistant message produced tool results is followed by
	// another turn; a turn without them is the run's last, so nothing follows
	// to read a report. Aborted and errored turns say nothing about the
	// machine's state either.
	if (event.toolResults.length === 0 || event.outcome !== "completed") return undefined;

	const report = await sampleAndReport(ctx, state, deps);
	if (!report) return undefined;

	return {
		entries: [
			...event.entries,
			{
				type: "custom_message",
				customType: MESSAGE_TYPE,
				content: report,
				display: true,
			},
		],
	};
}

/**
 * pi calls this with the extension API and nothing else, so every dependency
 * below has a production default. The parameter exists so tests can drive the
 * factory with deterministic samples instead of whatever the host machine
 * happens to be doing.
 */
export default function loadAwareSteer(pi: ExtensionAPI, deps: SteerDeps = {}): void {
	const resolved = resolveDeps(deps);

	const state = makeState();
	state.cpus = resolved.cpuCountImpl();

	// A factory also runs for invocations that never start a session, so
	// nothing is sampled here.
	pi.on("session_start", async (_event, ctx) => {
		state.loadBand = "normal";
		state.memoryBand = "normal";
		state.loadUnavailableNotified = false;
		state.memoryUnavailableNotified = false;
		state.cpus = resolved.cpuCountImpl();
		state.config = await resolved.loadConfigImpl();

		if (state.config.warnings.length > 0 && !state.configWarned) {
			state.configWarned = true;
			for (const warning of state.config.warnings) {
				if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: ${warning}`, "warning");
				console.error(`[load-aware-steer] ${warning}`);
			}
		}
	});

	// Both boundaries return a value; neither interrupts or starts a turn.
	pi.on("before_agent_start", (event, ctx) => beforeAgentStart(ctx, state, resolved, event));

	pi.on("turn_end", (event, ctx) => turnEnd(ctx, state, resolved, event));

	pi.on("session_shutdown", async (_event, ctx) => {
		// Nothing is stopped here, because nothing runs in the background:
		// the extension only ever acts inside these handlers.
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		state.loadBand = "normal";
		state.memoryBand = "normal";
	});
}
