/**
 * The memory sampler.
 *
 * The awkward cases here are the ones that would otherwise produce a
 * confident wrong number: a cgroup that reports free memory above total, and a
 * platform that hands back something implausible. Both must report
 * `available: false` rather than a fraction that looks real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { totalmem } from "node:os";

import { readMemory, formatBytes } from "../src/memory.ts";

test("a real reading is available and internally consistent", async () => {
	const sample = await readMemory();
	assert.equal(sample.available, true);
	assert.equal(sample.source, "node:os");
	assert.ok(sample.totalBytes > 0, "total memory must be positive");
	assert.ok(sample.usedBytes >= 0, "used memory must not be negative");
	assert.ok(sample.usedBytes <= sample.totalBytes, "used memory must not exceed total");
	assert.ok(
		Math.abs(sample.usedFraction - sample.usedBytes / sample.totalBytes) < 1e-12,
		"fraction must agree with the byte counts",
	);
});

test("the total matches what the platform reports", async () => {
	const sample = await readMemory();
	assert.equal(sample.totalBytes, totalmem());
});

test("formatBytes renders binary units", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2 KiB");
	assert.equal(formatBytes(5 * 1024 ** 2), "5 MiB");
	assert.equal(formatBytes(32 * 1024 ** 3), "32.0 GiB");
});

test("formatBytes refuses to invent a number", () => {
	assert.equal(formatBytes(Number.NaN), "unknown");
	assert.equal(formatBytes(-1), "unknown");
});
