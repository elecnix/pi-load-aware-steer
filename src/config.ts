/**
 * Configuration: defaults, optional JSON file, environment overrides.
 *
 * Precedence is defaults < config file < environment. The file is optional; a
 * missing or malformed file is not fatal, it leaves the defaults in place and
 * is reported through `warnings`.
 *
 * Each watched signal carries its own threshold, and the two are independent:
 * load is configured in load-average units (roughly runnable threads) and
 * memory as a percentage of installed RAM.
 */

import { cpus, availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { DEFAULT_BAND_CONFIG, type BandConfig } from "./signals.ts";

export type ThresholdSource = "default" | "file" | "env";

export type SteerConfig = BandConfig & {
	/** 1-minute load average at which the `elevated` band engages. */
	loadThreshold: number;
	/** Fraction of installed RAM in use at which the `elevated` band engages, 0-1. */
	memoryThreshold: number;
	/** Master switch. When false the extension samples and shows a status line but announces nothing. */
	enabled: boolean;
	loadThresholdSource: ThresholdSource;
	memoryThresholdSource: ThresholdSource;
	/** Non-fatal problems found while loading config. */
	warnings: string[];
};

const DEFAULT_CONFIG_PATH = `${homedir()}/.pi/agent/load-aware-steer.json`;

/**
 * Logical CPU count. Drives the default load threshold, and is reported in
 * every message so the reader can see load against core count.
 */
export function cpuCount(): number {
	const parallel = typeof availableParallelism === "function" ? availableParallelism() : 0;
	const count = parallel > 0 ? parallel : cpus().length;
	return count > 0 ? count : 1;
}

export const DEFAULTS = {
	/** One load unit per logical CPU: at this value the machine has as many
	 *  runnable threads as it has cores. */
	loadThreshold: cpuCount(),
	/** 80% of installed RAM. */
	memoryThresholdPercent: 80,
	enabled: true,
} as const;

function numberFrom(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function boolFrom(value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	return undefined;
}

export type LoadConfigOptions = {
	env?: NodeJS.ProcessEnv;
	/** Overrides the default config file location. */
	configPath?: string;
	/** Injected for tests. */
	readFileImpl?: (path: string) => Promise<string>;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SteerConfig> {
	const env = options.env ?? process.env;
	const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	const configPath = options.configPath ?? env.LOAD_AWARE_STEER_CONFIG ?? DEFAULT_CONFIG_PATH;

	const warnings: string[] = [];
	let fileValues: Record<string, unknown> = {};

	try {
		const parsed: unknown = JSON.parse(await readFileImpl(configPath));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			fileValues = parsed as Record<string, unknown>;
		} else {
			warnings.push(`ignoring ${configPath}: expected a JSON object`);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			warnings.push(`ignoring ${configPath}: ${(error as Error).message}`);
		}
	}

	const fileNumber = (key: string): number | undefined =>
		typeof fileValues[key] === "number" && Number.isFinite(fileValues[key] as number)
			? (fileValues[key] as number)
			: undefined;
	const fileBool = (key: string): boolean | undefined =>
		typeof fileValues[key] === "boolean" ? (fileValues[key] as boolean) : undefined;

	const loadEnv = numberFrom(env.LOAD_AWARE_STEER_LOAD_THRESHOLD);
	const loadFile = fileNumber("loadThreshold");
	const loadThreshold = loadEnv ?? loadFile ?? DEFAULTS.loadThreshold;
	const loadThresholdSource: ThresholdSource =
		loadEnv !== undefined ? "env" : loadFile !== undefined ? "file" : "default";

	if (loadThreshold <= 0) {
		warnings.push(`loadThreshold ${loadThreshold} is not positive; using default ${DEFAULTS.loadThreshold}`);
	}

	// Memory is configured as a percentage because that is how people reason
	// about RAM, and stored as a fraction because that is how it is compared.
	const memoryEnv = numberFrom(env.LOAD_AWARE_STEER_MEMORY_THRESHOLD);
	const memoryFile = fileNumber("memoryThresholdPercent");
	const rawMemoryPercent = memoryEnv ?? memoryFile ?? DEFAULTS.memoryThresholdPercent;
	const memoryThresholdSource: ThresholdSource =
		memoryEnv !== undefined ? "env" : memoryFile !== undefined ? "file" : "default";

	if (rawMemoryPercent <= 0 || rawMemoryPercent > 100) {
		warnings.push(`memoryThresholdPercent ${rawMemoryPercent} outside (0, 100]; using default ${DEFAULTS.memoryThresholdPercent}`);
	}
	const memoryThreshold =
		rawMemoryPercent > 0 && rawMemoryPercent <= 100 ? rawMemoryPercent / 100 : DEFAULTS.memoryThresholdPercent / 100;

	const hysteresis = numberFrom(env.LOAD_AWARE_STEER_HYSTERESIS) ?? fileNumber("hysteresis");
	if (hysteresis !== undefined && (hysteresis < 0 || hysteresis >= 1)) {
		warnings.push(`hysteresis ${hysteresis} outside [0, 1); using default ${DEFAULT_BAND_CONFIG.hysteresis}`);
	}

	const enabled = boolFrom(env.LOAD_AWARE_STEER_ENABLED) ?? fileBool("enabled") ?? DEFAULTS.enabled;

	return {
		loadThreshold: loadThreshold > 0 ? loadThreshold : DEFAULTS.loadThreshold,
		loadThresholdSource,
		memoryThreshold,
		memoryThresholdSource,
		enabled,
		warnings,
		elevatedMultiplier: DEFAULT_BAND_CONFIG.elevatedMultiplier,
		highMultiplier: DEFAULT_BAND_CONFIG.highMultiplier,
		hysteresis:
			hysteresis !== undefined && hysteresis >= 0 && hysteresis < 1 ? hysteresis : DEFAULT_BAND_CONFIG.hysteresis,
	};
}
