/**
 * Config resolution for the swap and I/O pressure thresholds.
 *
 * The extension suite injects a finished `SteerConfig`, which leaves the
 * environment and file resolution for these two settings unexercised. These
 * tests walk each one from an env var or the config file to a fraction, and
 * cover the out-of-range guard that replaces a bad value with the default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, DEFAULTS, type LoadConfigOptions } from "../src/config.ts";

const CONFIG_PATH = "/tmp/does-not-exist/load-aware-steer.json";

/** A config file that is not there, so only env and defaults contribute. */
const noFile = async (): Promise<string> => {
	const error = new Error("ENOENT") as NodeJS.ErrnoException;
	error.code = "ENOENT";
	throw error;
};

function load(env: NodeJS.ProcessEnv, contents?: string, options: LoadConfigOptions = {}) {
	return loadConfig({
		env,
		configPath: CONFIG_PATH,
		readFileImpl: contents === undefined ? noFile : async () => contents,
		...options,
	});
}

test("the shipped defaults are a 50% swap threshold and a 20% I/O threshold", async () => {
	const config = await load({});
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.ioThreshold, 0.2);
	assert.equal(config.swapThresholdSource, "default");
	assert.equal(config.ioThresholdSource, "default");
	assert.equal(DEFAULTS.swapThresholdPercent, 50);
	assert.equal(DEFAULTS.ioPressureThresholdPercent, 20);
	assert.deepEqual(config.warnings, []);
});

test("environment variables set both thresholds as percentages", async () => {
	const config = await load({
		LOAD_AWARE_STEER_SWAP_THRESHOLD: "70",
		LOAD_AWARE_STEER_IO_THRESHOLD: "35",
	});
	assert.equal(config.swapThreshold, 0.7);
	assert.equal(config.ioThreshold, 0.35);
	assert.equal(config.swapThresholdSource, "env");
	assert.equal(config.ioThresholdSource, "env");
});

test("the config file sets both thresholds when the environment is silent", async () => {
	const config = await load({}, JSON.stringify({ swapThresholdPercent: 30, ioPressureThresholdPercent: 5 }));
	assert.equal(config.swapThreshold, 0.3);
	assert.equal(config.ioThreshold, 0.05);
	assert.equal(config.swapThresholdSource, "file");
	assert.equal(config.ioThresholdSource, "file");
});

test("an environment value wins over the config file", async () => {
	const config = await load(
		{ LOAD_AWARE_STEER_SWAP_THRESHOLD: "60" },
		JSON.stringify({ swapThresholdPercent: 30, ioPressureThresholdPercent: 40 }),
	);
	assert.equal(config.swapThreshold, 0.6, "env beats file");
	assert.equal(config.swapThresholdSource, "env");
	assert.equal(config.ioThreshold, 0.4, "the file still supplies the other one");
	assert.equal(config.ioThresholdSource, "file");
});

test("a threshold outside (0, 100] warns and falls back to the default", async () => {
	for (const percent of ["0", "-5", "101"]) {
		const config = await load({ LOAD_AWARE_STEER_SWAP_THRESHOLD: percent, LOAD_AWARE_STEER_IO_THRESHOLD: percent });
		assert.equal(config.swapThreshold, 0.5, `swap ${percent}`);
		assert.equal(config.ioThreshold, 0.2, `io ${percent}`);
		assert.equal(config.warnings.length, 2, `both warnings for ${percent}`);
	}
});

test("a rejected value reports the default as its source, not where it came from", async () => {
	// The env var is out of range, so the number in use is the default. Saying
	// "env" would claim the environment supplied a value it did not.
	const config = await load({
		LOAD_AWARE_STEER_MEMORY_THRESHOLD: "0",
		LOAD_AWARE_STEER_SWAP_THRESHOLD: "150",
		LOAD_AWARE_STEER_IO_THRESHOLD: "0",
	});
	assert.equal(config.memoryThreshold, 0.8);
	assert.equal(config.memoryThresholdSource, "default");
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.swapThresholdSource, "default");
	assert.equal(config.ioThreshold, 0.2);
	assert.equal(config.ioThresholdSource, "default");

	// The load threshold is rejected on the same rule, and reports the same way.
	const rejectedLoad = await load({ LOAD_AWARE_STEER_LOAD_THRESHOLD: "0" });
	assert.equal(rejectedLoad.loadThreshold, DEFAULTS.loadThreshold);
	assert.equal(rejectedLoad.loadThresholdSource, "default");

	// The same rule through the file path.
	const fromFile = await load(
		{},
		JSON.stringify({ memoryThresholdPercent: 0, swapThresholdPercent: 0, ioPressureThresholdPercent: 0 }),
	);
	assert.equal(fromFile.memoryThresholdSource, "default");
	assert.equal(fromFile.swapThresholdSource, "default");
	assert.equal(fromFile.ioThresholdSource, "default");
});

test("a non-numeric environment value is ignored, not treated as zero", async () => {
	const config = await load({ LOAD_AWARE_STEER_SWAP_THRESHOLD: "half" });
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.swapThresholdSource, "default");
});
