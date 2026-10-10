/**
 * load-aware-steer
 *
 * Watches four signals on this machine — 1-minute load average, physical
 * memory in use, swap in use, and the share of wall time stalled on disk I/O —
 * and puts a number in the conversation when one of them changes band.
 *
 * It reports. It does not steer. There is no system-prompt nudge, no tool
 * block, no command deferral, and no registered command. The only thing this
 * extension ever does is sample four numbers, keep a status line current, and
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
import { readMemory, type MemorySample } from "./src/memory.ts";
import { readSwap, type SwapSample } from "./src/swap.ts";
import { readIoPressure, type IoPressureSample } from "./src/io.ts";
import { formatBytes } from "./src/format.ts";
import { nextBand, isCrossing, type Band } from "./src/signals.ts";
import { loadConfig, cpuCount, type SteerConfig } from "./src/config.ts";

const STATUS_KEY = "load-aware-steer";
const MESSAGE_TYPE = "load-aware-steer.update";

/** Identifies which of the watched signals a band belongs to. */
type Signal = "load" | "memory" | "swap" | "io";

type State = {
	config: SteerConfig | null;
	load: LoadSample | null;
	memory: MemorySample | null;
	swap: SwapSample | null;
	io: IoPressureSample | null;
	loadBand: Band;
	memoryBand: Band;
	swapBand: Band;
	ioBand: Band;
	cpus: number;
	/** One-shot guards so a broken sensor reports once per session, not per boundary. */
	loadUnavailableNotified: boolean;
	memoryUnavailableNotified: boolean;
	swapUnavailableNotified: boolean;
	ioUnavailableNotified: boolean;
	configWarned: boolean;
};

function makeState(): State {
	return {
		config: null,
		load: null,
		memory: null,
		swap: null,
		io: null,
		loadBand: "normal",
		memoryBand: "normal",
		swapBand: "normal",
		ioBand: "normal",
		cpus: cpuCount(),
		loadUnavailableNotified: false,
		memoryUnavailableNotified: false,
		swapUnavailableNotified: false,
		ioUnavailableNotified: false,
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

/** The band half of a signal's sentence: a crossing names both bands, an
 *  unchanged signal names the one it is sitting in. The caller's sentence
 *  carries no final punctuation so this can supply it. */
function bandClause(change: { previous: Band; next: Band } | undefined, current: Band): string {
	return change ? `. Band ${change.previous} -> ${change.next}.` : `, band ${current}.`;
}

/** Swap line body. A machine with no swap has a reading, not a percentage. */
function swapSentence(sample: SwapSample): string {
	if (sample.totalBytes === 0) return "Swap: none configured";
	return (
		`Swap: ${formatBytes(sample.usedBytes)} of ${formatBytes(sample.totalBytes)} in use ` +
		`(${(sample.usedFraction * 100).toFixed(0)}%)`
	);
}

/** I/O line body. The `full` share is named only when the kernel reported it. */
function ioSentence(sample: IoPressureSample): string {
	const some = (sample.some10 * 100).toFixed(1);
	const full =
		sample.full10 === null
			? ""
			: `, ${(sample.full10 * 100).toFixed(1)}% of wall time with every task stalled on I/O`;
	return `I/O pressure: ${some}% of wall time with at least one task stalled on I/O${full}`;
}

function formatCombinedReport(
	changes: Array<{ signal: Signal; previous: Band; next: Band }>,
	state: State,
): string {
	const changed = new Map<Signal, { previous: Band; next: Band }>();
	for (const change of changes) changed.set(change.signal, change);

	// Every signal with a reading gets a line, whether or not it changed, so one
	// message carries the full picture. A signal without a reading gets no line
	// at all, rather than a line describing what it does not have.
	const lines: string[] = ["System resource update. Measurements only."];

	if (state.load?.available) {
		const load = state.load;
		lines.push(
			`Load average: ${load.load1.toFixed(2)} (1 min), ${load.load5.toFixed(2)} (5 min), ` +
				`${load.load15.toFixed(2)} (15 min) on ${state.cpus} logical CPUs` +
				bandClause(changed.get("load"), state.loadBand),
		);
	}
	if (state.memory?.available) {
		const memory = state.memory;
		lines.push(
			`Memory: ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} in use ` +
				`(${(memory.usedFraction * 100).toFixed(0)}%)` +
				bandClause(changed.get("memory"), state.memoryBand),
		);
	}
	if (state.swap?.available) {
		lines.push(swapSentence(state.swap) + bandClause(changed.get("swap"), state.swapBand));
	}
	if (state.io?.available) {
		lines.push(ioSentence(state.io) + bandClause(changed.get("io"), state.ioBand));
	}

	return lines.join("\n");
}

/** Keep the footer status current. Presentation only, no thresholds implied. */
function updateStatus(ctx: ExtensionContext, state: State): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const load = state.load?.available ? state.load.load1.toFixed(2) : "—";
	const memory = state.memory?.available ? `${(state.memory.usedFraction * 100).toFixed(0)}%` : "—";
	const swap = !state.swap?.available
		? "—"
		: state.swap.totalBytes === 0
			? "none"
			: `${(state.swap.usedFraction * 100).toFixed(0)}%`;
	const io = state.io?.available ? `${(state.io.some10 * 100).toFixed(0)}%` : "—";
	const label = `load ${load}/${state.cpus} · mem ${memory} · swap ${swap} · io ${io}`;

	const bands: Band[] = [state.loadBand, state.memoryBand, state.swapBand, state.ioBand];
	const worst: Band = bands.includes("high") ? "high" : bands.includes("elevated") ? "elevated" : "normal";
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
	readSwapImpl?: () => Promise<SwapSample>;
	readIoPressureImpl?: () => Promise<IoPressureSample>;
	loadConfigImpl?: typeof loadConfig;
	cpuCountImpl?: () => number;
};

export type ResolvedDeps = Required<SteerDeps>;

function resolveDeps(deps: SteerDeps): ResolvedDeps {
	return {
		readLoadImpl: deps.readLoadImpl ?? readLoad,
		readMemoryImpl: deps.readMemoryImpl ?? readMemory,
		readSwapImpl: deps.readSwapImpl ?? readSwap,
		readIoPressureImpl: deps.readIoPressureImpl ?? readIoPressure,
		loadConfigImpl: deps.loadConfigImpl ?? loadConfig,
		cpuCountImpl: deps.cpuCountImpl ?? cpuCount,
	};
}

/**
 * The single sampling step both boundaries share.
 *
 * Takes one sample of every sensor, moves each band through the state
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

	const [load, memory, swap, io] = await Promise.all([
		deps.readLoadImpl(),
		deps.readMemoryImpl(),
		deps.readSwapImpl(),
		deps.readIoPressureImpl(),
	]);
	state.load = load;
	state.memory = memory;
	state.swap = swap;
	state.io = io;

	// An unavailable sensor is surfaced where the user can see it, once, and
	// its band holds until the sensor returns. A machine with no swap is not
	// unavailable: the reader reports the absence as a reading.
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
	if (!swap.available && !state.swapUnavailableNotified) {
		state.swapUnavailableNotified = true;
		if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: swap unavailable (${swap.detail}).`, "warning");
		console.error(`[load-aware-steer] swap unavailable: ${swap.detail}`);
	}
	if (!io.available && !state.ioUnavailableNotified) {
		state.ioUnavailableNotified = true;
		if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: I/O pressure unavailable (${io.detail}).`, "warning");
		console.error(`[load-aware-steer] I/O pressure unavailable: ${io.detail}`);
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

	if (swap.available) {
		const previous = state.swapBand;
		const next = nextBand(previous, swap.usedFraction, config.swapThreshold, config);
		if (isCrossing(previous, next)) {
			changes.push({ signal: "swap", previous, next });
			state.swapBand = next;
		}
	}

	if (io.available) {
		const previous = state.ioBand;
		const next = nextBand(previous, io.some10, config.ioThreshold, config);
		if (isCrossing(previous, next)) {
			changes.push({ signal: "io", previous, next });
			state.ioBand = next;
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
		state.swapBand = "normal";
		state.ioBand = "normal";
		state.loadUnavailableNotified = false;
		state.memoryUnavailableNotified = false;
		state.swapUnavailableNotified = false;
		state.ioUnavailableNotified = false;
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
		state.swapBand = "normal";
		state.ioBand = "normal";
	});
}
