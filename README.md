# pi-load-aware-steer

A pi extension that puts machine load, memory usage, swap usage and disk I/O pressure into the conversation when any one of them changes band.

The extension samples four numbers at two turn boundaries and nowhere else: when a user prompt starts an agent run (`before_agent_start`) and when a turn that ran tools ends (`turn_end`). The watched values are the 1-minute load average, the share of installed RAM in use, the share of swap in use, and the share of wall time the kernel records as stalled on disk I/O. When any value crosses a configured threshold, or falls back below it, the extension injects one message into the conversation with the current figures. Each message reports the 1, 5, and 15-minute load averages, the number of logical CPUs, memory used out of total, swap used out of total, and the I/O stall shares.

The measures are chosen to show pressure rather than activity. Memory follows the kernel's own accounting of memory in use, not a naive total-minus-free. Disk I/O pressure is the kernel's PSI stall accounting (`/proc/pressure/io`), the share of wall time tasks spent waiting on I/O, rather than a throughput, `%util` or `iowait` figure that can move without anything waiting.

All four signals are sampled together, and a sample that crosses several thresholds produces one combined message, not one message per signal. A signal that did not cross appears in that message with its current band.

There is no timer. While the agent sits idle between prompts, nothing is sampled and nothing accumulates; a crossing at one prompt is not repeated at the next.

Messages are delivered as handler results: the `before_agent_start` handler returns the message, and the `turn_end` handler appends it between the last tool result and the next assistant message. Neither interrupts the turn in progress nor starts a new one.

## What it does not do

The extension only reads and reports. It has no way to change your work:

- It never blocks a tool call, including shell commands.
- It never writes to the system prompt or steers the agent's behaviour.
- It registers no slash command.
- It never cancels a turn, closes a session, or discards work.

Messages contain measurements. They carry no instruction, and the test suite fails the build if a message ever contains imperative language aimed at the agent.

## Example

```
System resource update. Measurements only.
Load average: 18.21 (1 min), 22.46 (5 min), 42.82 (15 min) on 16 logical CPUs. Band normal -> elevated.
Memory: 21.1 GiB of 31.3 GiB in use (68%), band normal.
Swap: 13.9 GiB of 16.0 GiB in use (87%). Band normal -> high.
I/O pressure: 10.2% of wall time with at least one task stalled on I/O, 1.3% of wall time with every task stalled on I/O, band normal.
```

A footer status line shows the current figures continuously between crossings, for example `load 2.14/10 · mem 61% · swap 13% · io 5%`.

## Install

```
pi install git:github.com/elecnix/pi-load-aware-steer
```

Then run `/reload`. To install by hand instead:

```
ln -s /path/to/pi-load-aware-steer ~/.pi/agent/extensions/load-aware-steer
```

The package is marked `private` in `package.json` so it cannot be published to npm by accident. Install it from git.

## Bands

Each signal has three bands: `normal`, `elevated`, and `high`. The thresholds are the signal's own threshold multiplied by 1.0 and 1.5, and each band releases at 10% below its entry point. That margin is what keeps a value sitting on a boundary from producing a message at every sample.

An upward crossing moves straight to the band the sample justifies. A downward crossing steps down one band at a time, so a machine recovering passes through `high`, then `elevated`, then `normal`, with a message at each step.

If a sensor stops answering, its band is held rather than released. Treating missing data as quiet would manufacture a recovery out of a dead reader.

## Configuration

Settings resolve in the order defaults, then config file, then environment. The config file defaults to `~/.pi/agent/load-aware-steer.json` and is optional.

| Setting | Environment variable | File key | Default |
| --- | --- | --- | --- |
| Load threshold, in load-average units | `LOAD_AWARE_STEER_LOAD_THRESHOLD` | `loadThreshold` | Number of logical CPUs |
| Memory threshold, as a percent of RAM | `LOAD_AWARE_STEER_MEMORY_THRESHOLD` | `memoryThresholdPercent` | `80` |
| Swap threshold, as a percent of swap | `LOAD_AWARE_STEER_SWAP_THRESHOLD` | `swapThresholdPercent` | `50` |
| I/O pressure threshold, as a percent of wall time | `LOAD_AWARE_STEER_IO_THRESHOLD` | `ioPressureThresholdPercent` | `20` |
| Hysteresis as a fraction | `LOAD_AWARE_STEER_HYSTERESIS` | `hysteresis` | `0.1` |
| Master switch | `LOAD_AWARE_STEER_ENABLED` | `enabled` | `true` |
| Config file path | `LOAD_AWARE_STEER_CONFIG` | none | `~/.pi/agent/load-aware-steer.json` |
| Debug logging to stderr | `LOAD_AWARE_STEER_DEBUG=1` | none | unset |

A load threshold equal to the CPU count means the machine has as many runnable threads as it has cores. A memory threshold of 80 means 80% of installed RAM is in use. A swap threshold of 50 means half of the configured swap is committed. An I/O threshold of 20 means tasks were stalled on I/O for 20% of wall time.

With `enabled: false` the extension still samples at the boundaries and still updates the status line, but it appends no messages.

## Limitations

- Each pi session monitors itself. There is no shared state between sessions, so several sessions on one machine each report independently and none of them sees the others. A fleet-wide view would need an IPC layer this extension does not have.
- Memory figures follow each platform's own accounting of memory in use, because `os.freemem()` on its own counts reclaimable page cache as in use and reports near-saturation on a machine with a warm cache. On macOS the reader parses `vm_stat` and adds anonymous, wired and compressed pages, which is the total Activity Monitor shows. On Linux it reads `/proc/meminfo` and subtracts `MemAvailable` from `MemTotal`. Everywhere else, and whenever either source fails, it falls back to `os.totalmem() - os.freemem()`. The `source` field on a sample records which path produced the number, and `LOAD_AWARE_STEER_DEBUG=1` logs a fallback to stderr.
- Swap follows the platform too: `/proc/meminfo` on Linux and `sysctl vm.swapusage` on macOS. A machine with no swap reports `none configured` rather than a percentage of nothing, and a source that cannot be read reports unavailable rather than zero.
- Swap usage is a fill level, not a rate. It does not fall on its own, so a machine that filled its swap once holds the band while the pages stay there, whether or not it is paging now. The I/O pressure line is the moving figure beside it; swap says how much backing store is committed.
- I/O pressure comes from PSI, which is Linux-only. On macOS and Windows the extension reports it as unavailable, once per session, rather than substituting `%util` or `iowait`: a device can be busy, or the CPU counted as waiting, without any task being stalled, and the reverse. On Linux, a kernel built without PSI has no `/proc/pressure/io`, and that is reported the same way.
- Load average counts runnable and uninterruptible threads, so heavy disk I/O raises it even when the CPUs are idle.
- A value oscillating across a band boundary produces one message per crossing. Raise `hysteresis` to reduce the rate.
- `os.loadavg()` is absent on Windows, where it returns zeros. The extension reports the load as unavailable rather than treating a zero reading as an idle machine, and a footer status shows `—` for it.

## Development

```
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

The suite covers the band arithmetic, the load, memory, swap and I/O readers, and the extension factory. Factory tests inject their samplers through an optional second parameter on the default export and call the `before_agent_start` and `turn_end` handlers the way pi does, so they do not depend on what the host machine is doing while the tests run.

`src/signals.ts` holds the band machine and imports nothing from pi. It takes a value, a threshold, and the current band, and returns the next band. Every signal shares it: load passes a raw average, memory and swap pass fractions, and I/O pressure passes the `some avg10` share.

## License

MIT. See [LICENSE](LICENSE).
