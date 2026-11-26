/**
 * The disk I/O reader.
 *
 * Linux reads PSI stall share; macOS differences IOKit's cumulative device busy
 * time. The tests pin what makes either trustworthy: a missing source is never
 * zero, a first reading that cannot yet yield a rate says so rather than
 * reporting one, and a busy share is clamped instead of exceeding the wall
 * interval. The two measures stay labelled apart, because a disk can be busy
 * without anything waiting on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readIoPressure, parsePressure, parseIokitBusyNs } from "../src/io.ts";

const PSI = `some avg10=10.61 avg60=11.47 avg300=11.59 total=176015945404
full avg10=2.77 avg60=3.18 avg300=3.02 total=134160934492
`;

/** Some kernels report only `some`, and the reader tolerates that. */
const PSI_SOME_ONLY = "some avg10=0.00 avg60=0.01 avg300=0.03 total=859923879\n";

test("parsePressure reads the some and full lines", () => {
	const parsed = parsePressure(PSI);
	assert.ok(parsed, "a valid PSI file must parse");
	assert.deepEqual(parsed.some, { avg10: 10.61, avg60: 11.47, avg300: 11.59, totalMicros: 176015945404 });
	assert.ok(parsed.full);
	assert.equal(parsed.full.avg10, 2.77);
});

test("parsePressure tolerates a missing full line", () => {
	const parsed = parsePressure(PSI_SOME_ONLY);
	assert.ok(parsed);
	assert.equal(parsed.some.avg10, 0);
	assert.equal(parsed.full, null, "a line the kernel did not write is not invented");
});

test("parsePressure rejects output without a usable some line", () => {
	assert.equal(parsePressure(""), null);
	assert.equal(parsePressure("full avg10=2.77 avg60=3.18 avg300=3.02 total=1\n"), null);
	assert.equal(parsePressure("some avg10=oops avg60=3.18 avg300=3.02 total=1\n"), null);
	assert.equal(parsePressure("some avg10=-1 avg60=-1 avg300=-1 total=1\n"), null);
});

test("Linux reports the stall share as a fraction", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => PSI,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "/proc/pressure/io");
	assert.ok(Math.abs(sample.some10 - 0.1061) < 1e-12);
	assert.ok(sample.full10 !== null && Math.abs(sample.full10 - 0.0277) < 1e-12);
});

test("a full line the kernel omits becomes null, not zero", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => PSI_SOME_ONLY,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.full10, null);
});

test("Linux reports unavailable when /proc/pressure/io is missing", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => {
			throw new Error("ENOENT");
		},
	});
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.match(String(sample.detail), /unavailable/);
});

test("Linux reports unavailable when the file has no some line", async () => {
	const sample = await readIoPressure({ platform: "linux", readFileImpl: async () => "garbage\n" });
	assert.equal(sample.available, false);
	assert.equal(sample.some10, 0, "unavailable is not a stall reading");
});

test("a platform with no disk accounting at all reports unsupported, not unavailable", async () => {
	for (const platform of ["win32", "freebsd"] as const) {
		const sample = await readIoPressure({ platform });
		assert.equal(sample.available, false, `${platform} publishes nothing to read`);
		assert.equal(sample.source, "unsupported", `${platform} is an expected absence, not a dead sensor`);
		assert.match(String(sample.detail), new RegExp(platform));
	}
});

const IOREG_TWO_DISKS = `
+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1>
    {
      "Statistics" = {"Operations (Write)"=0,"Bytes (Read)"=0,"Total Time (Read)"=0,"Total Time (Write)"=0,"Operations (Read)"=0}
    }

+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x2>
  | {
  |   "Statistics" = {"Operations (Write)"=966286501,"Bytes (Read)"=33771576930304,"Total Time (Read)"=220547731120675,"Total Time (Write)"=39516323123361,"Operations (Read)"=1616322303}
  | }
`;

test("IOKit busy time is summed across every disk that reports it", () => {
	assert.equal(parseIokitBusyNs(IOREG_TWO_DISKS), 220547731120675 + 39516323123361);
});

test("an IOKit output with no statistics block yields null rather than zero", () => {
	assert.equal(parseIokitBusyNs("+-o IOBlockStorageDriver\n  | {\n  | }\n"), null);
});

test("macOS needs a second reading before it can report a rate", async () => {
	const sample = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => IOREG_TWO_DISKS,
	});
	assert.equal(sample.available, false, "one reading gives no interval to divide by");
	assert.equal(sample.source, "iokit-device-busy");
	assert.equal(sample.measure, "device-busy");
	assert.equal(sample.cumulativeBusyNs, 220547731120675 + 39516323123361, "the baseline is kept for next time");
	assert.match(String(sample.detail), /second reading/);
});

test("a macOS reading less than ten seconds after its baseline holds the last figure", async () => {
	// Tool turns end a second apart. A busy share over one second swings from a
	// few percent to half the interval, so the reader averages over at least ten
	// seconds, the same window as PSI avg10, and holds the last figure until then.
	const first = await readIoPressure({ platform: "darwin", execFileImpl: async () => IOREG_TWO_DISKS });
	const advanced = IOREG_TWO_DISKS.replace(/220547731120675/g, String(220547731120675 + 2_500_000_000));
	const early = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => advanced,
		previous: first,
		elapsedMs: 1000,
	});
	assert.equal(early.available, false, "one second is too short a window for a figure");
	assert.equal(early.source, "iokit-device-busy", "an open window is not a sensor fault");
	assert.equal(early.cumulativeBusyNs, first.cumulativeBusyNs, "the baseline stays where the window opened");
	assert.equal(early.windowElapsedMs, 1000);

	const closed = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => advanced,
		previous: early,
		elapsedMs: 9000,
	});
	assert.equal(closed.available, true);
	assert.equal(Number(closed.some10.toFixed(3)), 0.25, "2.5 s busy over the whole 10 s window");
	assert.equal(closed.windowElapsedMs, 0, "a closed window opens the next one");

	const held = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => IOREG_TWO_DISKS.replace(/220547731120675/g, String(220547731120675 + 9_000_000_000)),
		previous: closed,
		elapsedMs: 1000,
	});
	assert.equal(held.available, true);
	assert.equal(held.some10, closed.some10, "inside the next window the last closed figure stands");
});

test("macOS reports disk busy time as a share of the interval between readings", async () => {
	const first = await readIoPressure({ platform: "darwin", execFileImpl: async () => IOREG_TWO_DISKS });
	// 2.5 s of additional device busy time over a ten-second interval.
	const advanced = IOREG_TWO_DISKS.replace(/220547731120675/g, String(220547731120675 + 2_500_000_000));
	const second = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => advanced,
		previous: first,
		elapsedMs: 10_000,
	});
	assert.equal(second.available, true);
	assert.equal(second.source, "iokit-device-busy");
	assert.equal(second.measure, "device-busy", "the figure is busy time, never presented as a stall");
	assert.equal(Number(second.some10.toFixed(3)), 0.25);
	assert.equal(second.full10, null, "macOS publishes no every-task-stalled figure");
});

test("overlapping disks clamp the busy share instead of exceeding the interval", async () => {
	const first = await readIoPressure({ platform: "darwin", execFileImpl: async () => IOREG_TWO_DISKS });
	const advanced = IOREG_TWO_DISKS.replace(/220547731120675/g, String(220547731120675 + 20_000_000_000));
	const second = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => advanced,
		previous: first,
		elapsedMs: 10_000,
	});
	assert.equal(second.some10, 1, "twenty seconds of busy time in ten seconds is saturation, not 200%");
});

test("macOS reports unavailable when ioreg itself fails, because that is a fault", async () => {
	const sample = await readIoPressure({
		platform: "darwin",
		execFileImpl: async () => {
			throw new Error("ioreg not found");
		},
	});
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.match(String(sample.detail), /ioreg/);
});

test("Linux keeps reporting unavailable when the PSI source cannot be read", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => {
			throw new Error("EACCES");
		},
	});
	assert.equal(sample.source, "unavailable", "a readable platform with an unreadable source is a fault");
});

test("a real reading on this host is available and bounded", async () => {
	const sample = await readIoPressure();
	if (!sample.available) {
		// A first macOS reading waits for its second; a host with no source says
		// so. Neither may present zeros as a measurement.
		assert.ok(
			["unsupported", "unavailable", "iokit-device-busy"].includes(sample.source),
			`an unavailable sample names why: ${sample.source}`,
		);
		assert.ok(sample.detail);
		return;
	}
	assert.ok(sample.some10 >= 0);
	if (sample.full10 !== null) {
		assert.ok(sample.full10 >= 0);
		assert.ok(sample.full10 <= sample.some10, "full stall time cannot exceed some stall time");
	}
});
