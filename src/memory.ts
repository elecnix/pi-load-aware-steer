/**
 * Physical memory reader.
 *
 * Reports one number: how much of the machine's RAM is in use. The extension
 * is read-only, so this module only ever observes — it never allocates, frees,
 * or touches another process.
 *
 * Source is os.totalmem() and os.freemem(). See the macOS caveat in the README:
 * freemem counts reclaimable filesystem cache as free, so the reported
 * used-bytes can read low on a machine with a warm page cache. That is a
 * property of the platform, not a bug here, and it is why the band thresholds
 * are configurable.
 */

import { totalmem, freemem } from "node:os";

export type MemorySource = "node:os" | "unavailable";

export type MemorySample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	totalBytes: number;
	usedBytes: number;
	/** usedBytes / totalBytes, clamped to [0, 1]. 0 when unavailable. */
	usedFraction: number;
	source: MemorySource;
	/** Why the sample is unavailable. */
	detail?: string;
};

const BYTES_PER_GIB = 1024 ** 3;

export async function readMemory(): Promise<MemorySample> {
	let total: number;
	let free: number;
	try {
		total = totalmem();
		free = freemem();
	} catch (error) {
		return {
			available: false,
			totalBytes: 0,
			usedBytes: 0,
			usedFraction: 0,
			source: "unavailable",
			detail: `memory read failed: ${(error as Error).message}`,
		};
	}

	if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
		return {
			available: false,
			totalBytes: 0,
			usedBytes: 0,
			usedFraction: 0,
			source: "unavailable",
			detail: `implausible memory reading: total=${total}, free=${free}`,
		};
	}

	// free() can exceed total() under container cgroup accounting on Linux, and
	// rounding at the boundary can push it one byte over. Clamp rather than
	// report a negative used-bytes figure.
	const usedBytes = Math.min(Math.max(total - free, 0), total);

	return {
		available: true,
		totalBytes: total,
		usedBytes,
		usedFraction: usedBytes / total,
		source: "node:os",
	};
}

/** Human-readable byte count, binary units. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
	if (bytes >= BYTES_PER_GIB) return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
	return `${bytes} B`;
}
