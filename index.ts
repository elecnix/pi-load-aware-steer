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
 * Messages are delivered with `deliverAs: "nextTurn"`, which neither interrupts
 * the current turn nor starts one. They surface at the start of whatever turn
 * comes next, and are otherwise inert.
 *
 * Band changes are reported in both directions, so a machine recovering is as
 * visible as one saturating. Hysteresis keeps a value hovering at a boundary
 * from producing a message on every poll.
 *
 * Loaded via jiti, so TypeScript needs no build step.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readLoad, type LoadSample } from "./src/load.ts";
import { readMemory, formatBytes, type MemorySample } from "./src/memory.ts";
import { nextBand, isCrossing, type Band } from "./src/signals.ts";
import { loadConfig, cpuCount, type SteerConfig } from "./src/config.ts";

const STATUS_KEY = "load-aware-steer";

/** Identifies which of the two signals a band belongs to. */
type Signal = "load" | "memory";

type State = {
	config: SteerConfig | null;
	load: LoadSample | null;
	memory: MemorySample | null;
	loadBand: Band;
	memoryBand: Band;
	cpus: number;
	timer: ReturnType<typeof setInterval> | null;
	/** One-shot guards so a broken sensor reports once per session, not per poll. */
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
		timer: null,
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
 * Compose the conversation message for a band crossing.
 *
 * Every sentence is a measurement or a statement about which band changed.
 * There is no imperative anywhere in this function, and that is the point:
 * the reader gets the numbers and draws their own conclusion.
 */
function formatUpdate(signal: Signal, previous: Band, next: Band, state: State): string {
	const lines: string[] = ["System resource update. Measurements only."];

	if (signal === "load" && state.load?.available) {
		lines.push(
			`Load average: ${state.load.load1.toFixed(2)} (1 min), ${state.load.load5.toFixed(2)} (5 min), ` +
				`${state.load.load15.toFixed(2)} (15 min) on ${state.cpus} logical CPUs. ` +
				`Band ${previous} -> ${next}.`,
		);
	}

	if (signal === "memory" && state.memory?.available) {
		lines.push(
			`Memory: ${formatBytes(state.memory.usedBytes)} of ${formatBytes(state.memory.totalBytes)} in use ` +
				`(${(state.memory.usedFraction * 100).toFixed(0)}%). Band ${previous} -> ${next}.`,
		);
	}

	// Always report the other signal too, so one message carries the full picture.
	if (signal === "load" && state.memory?.available) {
		lines.push(
			`Memory: ${formatBytes(state.memory.usedBytes)} of ${formatBytes(state.memory.totalBytes)} in use ` +
				`(${(state.memory.usedFraction * 100).toFixed(0)}%), band ${state.memoryBand}.`,
		);
	}
	if (signal === "memory" && state.load?.available) {
		lines.push(
			`Load average: ${state.load.load1.toFixed(2)} (1 min) on ${state.cpus} logical CPUs, band ${state.loadBand}.`,
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

function announce(pi: ExtensionAPI, signal: Signal, previous: Band, next: Band, state: State): void {
	const content = formatUpdate(signal, previous, next, state);
	pi.sendMessage(
		{
			customType: "load-aware-steer.update",
			content,
			// Shown in the transcript: the point of the message is that the
			// reader sees it, not just that the model does.
			display: true,
		},
		// nextTurn neither interrupts the running turn nor starts a new one. The
		// message lands at the top of whatever turn comes next and is inert until then.
		{ deliverAs: "nextTurn", triggerTurn: false },
	);
	if (debugEnabled()) {
		console.error(`[load-aware-steer] ${signal} ${previous} -> ${next}; announced`);
	}
}

export type ResolvedDeps = Required<SteerDeps>;

function resolveDeps(deps: SteerDeps): ResolvedDeps {
	return {
		readLoadImpl: deps.readLoadImpl ?? readLoad,
		readMemoryImpl: deps.readMemoryImpl ?? readMemory,
		loadConfigImpl: deps.loadConfigImpl ?? loadConfig,
		cpuCountImpl: deps.cpuCountImpl ?? cpuCount,
	};
}

async function poll(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	deps: ResolvedDeps,
): Promise<void> {
	const config = state.config;
	if (!config) return;

	const [load, memory] = await Promise.all([deps.readLoadImpl(), deps.readMemoryImpl()]);
	state.load = load;
	state.memory = memory;

	if (!load.available) {
		if (!state.loadUnavailableNotified) {
			state.loadUnavailableNotified = true;
			if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: load average unavailable (${load.detail}).`, "warning");
			console.error(`[load-aware-steer] load unavailable: ${load.detail}`);
		}
	}
	if (!memory.available) {
		if (!state.memoryUnavailableNotified) {
			state.memoryUnavailableNotified = true;
			if (ctx.hasUI) ctx.ui.notify(`load-aware-steer: memory unavailable (${memory.detail}).`, "warning");
			console.error(`[load-aware-steer] memory unavailable: ${memory.detail}`);
		}
	}

	updateStatus(ctx, state);
	if (!config.enabled) return;

	// An unavailable signal holds its band. Missing data must never be read as
	// "quiet", which would manufacture a downward crossing out of a dead sensor.
	if (load.available) {
		const previous = state.loadBand;
		const next = nextBand(previous, load.load1, config.loadThreshold, config);
		if (isCrossing(previous, next)) {
			state.loadBand = next;
			announce(pi, "load", previous, next, state);
		}
	}

	if (memory.available) {
		const previous = state.memoryBand;
		const next = nextBand(previous, memory.usedFraction, config.memoryThreshold, config);
		if (isCrossing(previous, next)) {
			state.memoryBand = next;
			announce(pi, "memory", previous, next, state);
		}
	}
}

function stopPolling(state: State): void {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
}

function startPolling(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	deps: ResolvedDeps,
): void {
	stopPolling(state);
	const config = state.config;
	if (!config) return;

	void poll(pi, ctx, state, deps);
	state.timer = setInterval(() => {
		void poll(pi, ctx, state, deps);
	}, config.intervalMs);
	// Never keep the process alive on our account.
	(state.timer as { unref?: () => void }).unref?.();
}

export type SteerDeps = {
	/** Injected for tests. Defaults to the real sampler. */
	readLoadImpl?: () => Promise<LoadSample>;
	readMemoryImpl?: () => Promise<MemorySample>;
	loadConfigImpl?: typeof loadConfig;
	cpuCountImpl?: () => number;
};

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

	// A factory also runs for invocations that never start a session, so no
	// timer or other background resource is started here.
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

		startPolling(pi, ctx, state, resolved);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Idempotent: safe on quit, reload, new, resume and fork.
		stopPolling(state);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		state.loadBand = "normal";
		state.memoryBand = "normal";
	});
}
