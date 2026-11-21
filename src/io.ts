/**
 * Disk I/O contention reader, from Linux PSI (Pressure Stall Information).
 *
 * The measure is the kernel's own stall accounting in `/proc/pressure/io`:
 * the share of wall time in which tasks were waiting on I/O rather than
 * running. That is the pressure itself, not a proxy for it.
 *
 * The alternatives are all misleading by comparison:
 *
 *   - Throughput (bytes/s or IOPS) says how much work is moving, not whether
 *     anything is waiting. A saturated NVMe and a dying disk can move the same
 *     number.
 *   - `%util` / `%busy` says a device had a request in flight, which on a
 *     queueing device is true long before latency suffers and says nothing
 *     about whether a task was blocked.
 *   - `iowait` from `/proc/stat` overcounts: it includes idle time that
 *     happened to overlap an outstanding request and misses stalls on tasks
 *     that were runnable elsewhere. The kernel documents it as unreliable.
 *
 * PSI `some` is the band driver: it is the broader figure — the time any task
 * was stalled — so `full` (the time every task was stalled) can never exceed
 * it. A machine with heavy `full` stalls necessarily has high `some`, which
 * makes `some` the safe single trigger and `full` the severity detail.
 *
 * PSI is Linux-only. macOS and Windows publish no equivalent accounting, and
 * a utilization or queue-depth number would answer a different question, so
 * those platforms report `available: false` with source `unsupported`, which
 * marks an expected absence rather than a sensor that failed.
 */

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `unsupported` marks an expected platform absence — a system that publishes no
 * such accounting at all — and is distinct from `unavailable`, which marks a
 * machine that has the source and cannot read it. Callers surface a dead
 * sensor; a missing feature is not a fault.
 *
 * `iokit-device-busy` marks macOS, where the figure is derived from IOKit's
 * own per-device busy time rather than from PSI. The two quantities are not the
 * same and the sample says which one it carries: PSI counts wall time in which
 * a task was stalled, IOKit counts wall time in which a disk had a request
 * outstanding, which a queueing device reports long before anything waits.
 */
export type IoPressureSource = "/proc/pressure/io" | "iokit-device-busy" | "unavailable" | "unsupported";

/** Which quantity `some10` carries. Never present one as the other. */
export type IoMeasure = "stall" | "device-busy";

export type IoPressureSample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	/** The measured share of wall time, as a fraction. PSI `some avg10` on Linux;
	 *  aggregate disk busy time on macOS. `measure` says which. */
	some10: number;
	/** `full avg10` as a fraction, or null when the kernel did not report it. */
	full10: number | null;
	source: IoPressureSource;
	/** Why the sample is unavailable. */
	detail?: string;
	/** The quantity `some10` carries, absent when there is no figure. */
	measure?: IoMeasure;
	/** Cumulative device busy nanoseconds, the baseline for the next sample's
	 *  rate. Only macOS carries it, and it is never presented as a figure. */
	cumulativeBusyNs?: number;
};

export type IoPressureReaderOptions = {
	/** Overrides process.platform. Injected for tests. */
	platform?: NodeJS.Platform;
	/** Injected for tests. Defaults to fs.readFile(path, "utf8"). */
	readFileImpl?: (path: string) => Promise<string>;
	/** Injected for tests. Defaults to running the command. */
	execFileImpl?: (file: string, args: string[]) => Promise<string>;
	/** The previous sample, when a rate needs two readings. */
	previous?: IoPressureSample | null;
	/** Milliseconds between the previous sample and this one. */
	elapsedMs?: number;
};

/** One `some` or `full` line of a PSI file. Averages are percentages, so
 *  `avg10` may exceed 100 only if the kernel reports it that way. */
export type PressureAverages = {
	avg10: number;
	avg60: number;
	avg300: number;
	totalMicros: number;
};

function pressureLine(output: string, kind: "some" | "full"): PressureAverages | null {
	const match = new RegExp(
		`^${kind}\\s+avg10=([0-9.]+)\\s+avg60=([0-9.]+)\\s+avg300=([0-9.]+)\\s+total=(\\d+)`,
		"m",
	).exec(output);
	if (!match) return null;

	const [avg10, avg60, avg300, total] = match.slice(1).map(Number);
	if (![avg10, avg60, avg300, total].every((value) => Number.isFinite(value) && value >= 0)) return null;

	return { avg10, avg60, avg300, totalMicros: total };
}

/**
 * Parse `/proc/pressure/io`. Returns null when the `some` line is absent or
 * unparsable; a missing `full` line is tolerated because it is supplementary.
 */
export function parsePressure(output: string): { some: PressureAverages; full: PressureAverages | null } | null {
	const some = pressureLine(output, "some");
	if (!some) return null;
	return { some, full: pressureLine(output, "full") };
}

function unavailable(detail: string): IoPressureSample {
	return { available: false, some10: 0, full10: null, source: "unavailable", detail };
}

function unsupported(detail: string): IoPressureSample {
	return { available: false, some10: 0, full10: null, source: "unsupported", detail };
}

/**
 * Sum the device busy time IOKit reports, in nanoseconds.
 *
 * `ioreg -c IOBlockStorageDriver` prints one `Statistics` dictionary per disk,
 * each holding cumulative `Total Time (Read)` and `Total Time (Write)`. Those
 * are nanoseconds the device spent with a request in flight, so differencing
 * two readings over a known wall interval gives the share of that interval the
 * machine's disks were busy. Returns null when no dictionary carries the
 * fields, which means the driver layout is not what this parser knows.
 */
export function parseIokitBusyNs(output: string): number | null {
	let total = 0;
	let found = false;
	for (const block of output.matchAll(/"Statistics" = \{([^}]*)\}/g)) {
		const body = block[1];
		const ns = (key: string): number | null => {
			const match = new RegExp(`"${key}"=(\\d+)`).exec(body);
			if (!match) return null;
			const value = Number(match[1]);
			return Number.isFinite(value) ? value : null;
		};
		const readNs = ns("Total Time \\(Read\\)");
		const writeNs = ns("Total Time \\(Write\\)");
		if (readNs === null && writeNs === null) continue;
		found = true;
		total += (readNs ?? 0) + (writeNs ?? 0);
	}
	return found ? total : null;
}

/**
 * Disk busy share on macOS, from IOKit's per-device accounting.
 *
 * macOS has no PSI, so there is no stall figure to read. What the kernel does
 * publish is how long each disk held an outstanding request, which is a real
 * measurement of the same quantity Linux calls `%util`. It is reported as
 * `device-busy` and never confused with a stall: a queueing device is busy
 * before anything waits on it.
 *
 * A rate needs two readings, so the first sample of a session stores its
 * baseline and returns no figure. Every later sample differences against it.
 */
async function darwinBusy(options: IoPressureReaderOptions): Promise<IoPressureSample> {
	const run = options.execFileImpl ?? (async (file: string, args: string[]) => {
		const { stdout } = await execFileAsync(file, args, { timeout: 2000 });
		return stdout;
	});

	let busyNs: number | null;
	try {
		busyNs = parseIokitBusyNs(await run("ioreg", ["-r", "-c", "IOBlockStorageDriver", "-k", "Statistics", "-l"]));
	} catch (error) {
		return unavailable(`ioreg unavailable: ${(error as Error).message}`);
	}
	if (busyNs === null) return unavailable("ioreg reported no disk busy time");

	const previous = options.previous;
	const elapsedMs = options.elapsedMs ?? 0;
	const hasBaseline =
		previous != null &&
		previous.source === "iokit-device-busy" &&
		typeof previous.cumulativeBusyNs === "number" &&
		elapsedMs > 0;

	if (!hasBaseline) {
		return {
			available: false,
			some10: 0,
			full10: null,
			source: "iokit-device-busy",
			measure: "device-busy",
			cumulativeBusyNs: busyNs,
			detail: "a second reading is required for a rate",
		};
	}

	const elapsedNs = elapsedMs * 1_000_000;
	const busy = (busyNs - (previous.cumulativeBusyNs as number)) / elapsedNs;
	return {
		available: true,
		// Disks can overlap, so the aggregate can exceed the wall interval.
		// A share above 1 means every disk busy at once, which is saturated.
		some10: Math.min(1, Math.max(0, busy)),
		full10: null,
		source: "iokit-device-busy",
		measure: "device-busy",
		cumulativeBusyNs: busyNs,
	};
}

/**
 * Read disk I/O pressure. Never throws: a missing or unreadable source is
 * reported as `available: false` so callers can stay quiet rather than guess.
 */
export async function readIoPressure(options: IoPressureReaderOptions = {}): Promise<IoPressureSample> {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") return darwinBusy(options);
	if (platform !== "linux") {
		return unsupported(`no disk pressure accounting on ${platform}`);
	}

	const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	try {
		const parsed = parsePressure(await read("/proc/pressure/io"));
		if (!parsed) return unavailable("/proc/pressure/io reported no some avg10");
		return {
			available: true,
			some10: parsed.some.avg10 / 100,
			full10: parsed.full ? parsed.full.avg10 / 100 : null,
			source: "/proc/pressure/io",
			measure: "stall",
		};
	} catch (error) {
		return unavailable(`/proc/pressure/io unavailable: ${(error as Error).message}`);
	}
}
