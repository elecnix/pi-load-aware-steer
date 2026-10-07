# pi-load-aware-steer

A pi extension that puts machine load and memory usage into the conversation when either one changes band.

The extension samples two numbers at two turn boundaries and nowhere else: when a user prompt starts an agent run (`before_agent_start`) and when a turn that ran tools ends (`turn_end`). The watched values are the 1-minute load average and the share of installed RAM in use. When either crosses a configured threshold, or falls back below it, the extension injects one message into the conversation with the current figures. Each message reports the 1, 5, and 15-minute load averages, the number of logical CPUs, and memory used out of total.

Both signals are sampled together, and a sample that crosses both thresholds produces one combined message, not one message per signal. A signal that did not cross appears in that message with its current band.

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
Load average: 5.00 (1 min), 4.80 (5 min), 4.10 (15 min) on 10 logical CPUs. Band normal -> elevated.
Memory: 16.0 GiB of 32.0 GiB in use (50%), band normal.
```

A footer status line shows both figures continuously between crossings, for example `load 2.14/10 · mem 61%`.

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
| Hysteresis as a fraction | `LOAD_AWARE_STEER_HYSTERESIS` | `hysteresis` | `0.1` |
| Master switch | `LOAD_AWARE_STEER_ENABLED` | `enabled` | `true` |
| Config file path | `LOAD_AWARE_STEER_CONFIG` | none | `~/.pi/agent/load-aware-steer.json` |
| Debug logging to stderr | `LOAD_AWARE_STEER_DEBUG=1` | none | unset |

A load threshold equal to the CPU count means the machine has as many runnable threads as it has cores. A memory threshold of 80 means 80% of installed RAM is in use.

With `enabled: false` the extension still samples at the boundaries and still updates the status line, but it appends no messages.

## Limitations

- Each pi session monitors itself. There is no shared state between sessions, so several sessions on one machine each report independently and none of them sees the others. A fleet-wide view would need an IPC layer this extension does not have.
- Memory figures follow each platform's own accounting of memory in use, because `os.freemem()` on its own counts reclaimable page cache as in use and reports near-saturation on a machine with a warm cache. On macOS the reader parses `vm_stat` and adds anonymous, wired and compressed pages, which is the total Activity Monitor shows. On Linux it reads `/proc/meminfo` and subtracts `MemAvailable` from `MemTotal`. Everywhere else, and whenever either source fails, it falls back to `os.totalmem() - os.freemem()`. The `source` field on a sample records which path produced the number, and `LOAD_AWARE_STEER_DEBUG=1` logs a fallback to stderr.
- Load average counts runnable and uninterruptible threads, so heavy disk I/O raises it even when the CPUs are idle.
- A value oscillating across a band boundary produces one message per crossing. Raise `hysteresis` to reduce the rate.
- `os.loadavg()` is absent on Windows, where it returns zeros. The extension reports the load as unavailable rather than treating a zero reading as an idle machine, and a footer status shows `—` for it.

## Development

```
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

The suite covers the band arithmetic, the load and memory readers, and the extension factory. Factory tests inject their samplers through an optional second parameter on the default export and call the `before_agent_start` and `turn_end` handlers the way pi does, so they do not depend on what the host machine is doing while the tests run.

`src/signals.ts` holds the band machine and imports nothing from pi. It takes a value, a threshold, and the current band, and returns the next band. Both signals share it: load passes a raw average, memory passes a fraction.

## License

MIT. See [LICENSE](LICENSE).
