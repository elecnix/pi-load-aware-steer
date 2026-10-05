# pi-load-aware-steer

A pi extension that puts machine load and memory usage into the conversation when either one changes band.

The extension samples two numbers on an interval: the 1-minute load average and the share of installed RAM in use. When either crosses a configured threshold, or falls back below it, the extension appends a message to the conversation with the current figures. Each message reports the 1, 5, and 15-minute load averages, the number of logical CPUs, and memory used out of total.

Messages are delivered with `deliverAs: "nextTurn"` and `triggerTurn: false`, so a message neither interrupts the turn in progress nor starts a new one. It appears at the top of the next turn that happens.

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

Each signal has three bands: `normal`, `elevated`, and `high`. The thresholds are the signal's own threshold multiplied by 1.0 and 1.5, and each band releases at 10% below its entry point. That margin is what keeps a value sitting on a boundary from producing a message on every poll.

An upward crossing moves straight to the band the sample justifies. A downward crossing steps down one band at a time, so a machine recovering passes through `high`, then `elevated`, then `normal`, with a message at each step.

If a sensor stops answering, its band is held rather than released. Treating missing data as quiet would manufacture a recovery out of a dead reader.

## Configuration

Settings resolve in the order defaults, then config file, then environment. The config file defaults to `~/.pi/agent/load-aware-steer.json` and is optional.

| Setting | Environment variable | File key | Default |
| --- | --- | --- | --- |
| Load threshold, in load-average units | `LOAD_AWARE_STEER_LOAD_THRESHOLD` | `loadThreshold` | Number of logical CPUs |
| Memory threshold, as a percent of RAM | `LOAD_AWARE_STEER_MEMORY_THRESHOLD` | `memoryThresholdPercent` | `80` |
| Sample interval in milliseconds | `LOAD_AWARE_STEER_INTERVAL_MS` | `intervalMs` | `15000` |
| Hysteresis as a fraction | `LOAD_AWARE_STEER_HYSTERESIS` | `hysteresis` | `0.1` |
| Master switch | `LOAD_AWARE_STEER_ENABLED` | `enabled` | `true` |
| Config file path | `LOAD_AWARE_STEER_CONFIG` | none | `~/.pi/agent/load-aware-steer.json` |
| Debug logging to stderr | `LOAD_AWARE_STEER_DEBUG=1` | none | unset |

A load threshold equal to the CPU count means the machine has as many runnable threads as it has cores. A memory threshold of 80 means 80% of installed RAM is in use.

With `enabled: false` the extension still samples and still updates the status line, but it appends no messages.

## Limitations

- Each pi session monitors itself. There is no shared state between sessions, so several sessions on one machine each report independently and none of them sees the others. A fleet-wide view would need an IPC layer this extension does not have.
- Memory figures come from `os.totalmem()` and `os.freemem()`. On macOS, `freemem` counts reclaimable page cache as free, so used memory can read low on a machine with a warm cache. That is a platform property, and it is why the memory threshold is configurable.
- Load average counts runnable and uninterruptible threads, so heavy disk I/O raises it even when the CPUs are idle.
- A value oscillating across a band boundary produces one message per crossing. Raise `intervalMs` or `hysteresis` to reduce the rate.
- `os.loadavg()` is absent on Windows, where it returns zeros. The extension reports the load as unavailable rather than treating a zero reading as an idle machine, and a footer status shows `—` for it.

## Development

```
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

The suite covers the band arithmetic, the load and memory readers, and the extension factory. Factory tests inject their samplers through an optional second parameter on the default export, so they do not depend on what the host machine is doing while the tests run.

`src/signals.ts` holds the band machine and imports nothing from pi. It takes a value, a threshold, and the current band, and returns the next band. Both signals share it: load passes a raw average, memory passes a fraction.

## License

MIT. See [LICENSE](LICENSE).
