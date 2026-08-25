# Fork changes

This repository is a fork of [MiaAI-Lab/sparkDash](https://github.com/MiaAI-Lab/sparkDash)
(all credit for the original project to Mia'a AI Lab — this file only documents what's
different here). It was forked at upstream commit `88aefcc` (Release 1.8.2 — "EXL3 live
tok/s and Docker Hub IPv6 workaround").

The changes below were made to run sparkDash against a single, always-local DGX Spark
(no dedicated GPU hosts, no remote Sparks over SSH) and to fill in two metrics the
upstream `kind: "spark"` path didn't detect.

## 1. Detect the installed NVIDIA driver version for DGX Spark units

**Problem:** `SparkMonitor._staticHardwareSummary()` hardcodes `cudaDriver: null` for
`kind: "spark"` units. The static DGX Spark spec block (`cpuModel`, `cpuCores`,
`totalMemoryGB`, `gpuChip`) is correct to keep fixed — those really are constant across
every GB10 unit — but the installed driver version is per-machine and varies by install,
so leaving it hardcoded `null` means it's simply never shown.

**Fix:** reuse the same `SystemCollector.detectHardware()` probe already used for
`kind: "host"` units, but for `kind: "spark"` only merge in the detected `cudaDriver`
field — the rest of the static summary is untouched.

- `server/sparks/SparkMonitor.js`

## 2. CPU load average (1m / 5m / 15m)

**Problem:** `collectCpu()` / `_getRemoteCpu()` return `usage`, `temperature`, `draw`,
`tdp` — no load average, even though it's one extra read of a file that's already
available (`/proc/loadavg` locally via the existing host-proc bind mount, or over SSH
for remote Sparks).

**Fix:** both the local and remote CPU collectors now also read `/proc/loadavg` and
return `loadAvg: [number, number, number] | null`, fed into the shared metrics history
store (`cpu.loadavg1`) the same way `gpu.usage` / `gpu.temp` already are, so it has a
sparkline series available.

- `server/collectors/SystemCollector.js`
- `src/hooks/metricsStore.ts`
- `src/api/types.ts` — `CpuMetrics.loadAvg`

## 3. Spark header UI: driver version + load-average block

**Problem:** with (1) and (2) landed, the data existed but nothing rendered it —
`kind: "spark"` units don't get a CPU panel at all in the current layout (`SparkPage.tsx`
only wires `RamPanel`'s combined CPU display for `kind: "host"`), and the header's
device line never showed a driver version.

**Fix**, in `src/components/SparkPage/SparkHeader.tsx`:

- Subtitle line now reads `NVIDIA DGX Spark · GB10 · Driver <version>` when the driver
  is known.
- A small block sits between the title area and the Shutdown/Edit buttons showing all
  three load-average values (`1.03 · 1.11 · 1.18`) plus an inline sparkline
  (`cpu.loadavg1` history). Color-coded the same way the storage/RAM/GPU-temp bars
  already are elsewhere in the app: accent at normal load, warning above ~80% of
  `cpuCores`, danger above 100%.
- (An earlier iteration put this as a tiny inline pill next to the Standalone/uptime
  badges, relying on the native `title` attribute for the 5m/15m values on hover. That
  attribute was correct on inspection, but a native-tooltip hover delay made it easy to
  miss in practice — showing all three values directly reads better.)

## Not changed

Everything else — ComfyUI monitoring, Hermes Agent, Tailnet probe, the sandbox stack
integration guidance, ports, Docker Compose shape — is unmodified upstream behavior.
