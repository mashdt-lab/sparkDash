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

## 4. Daily peak GPU temp/power chart

**Problem:** GB10 has a documented history (in the community, and in this fork's own
ComfyUI tooling notes) of hard reboots from power/thermal spikes under heavy load, but
sparkDash's in-memory metrics history is a 1-hour rolling window — not enough to answer
"how hot did it get under load" over a longer stretch without grepping a separate log
file by hand.

**Fix:** a new `GpuDailyStore`, structurally identical to the existing `LlmDailyStore`
(`server/collectors/LlmDaily.js`) — one record per Spark per UTC day, tracking
max + average temperature and power draw, persisted to `config/gpu-daily.json` and
capped at 30 days. Exposed as `GET /api/sparks/:id/gpu/daily` and rendered as a bar
chart under the GPU panel's process list, color-coded the same way the live GPU-temp
bar already is (accent / warning at 80°C / danger at 90°C). Hovering a day's bar shows
both temp and power, max and average.

Unlike the LLM daily rollup, there's no "busy" gate — an idle GPU sample is still a
real data point (a GPU that's always cool is exactly as informative as one that spikes).

- `server/collectors/GpuDaily.js` (new)
- `server/sparks/SparkMonitor.js` — `gpuDaily.record()` on every GPU poll
- `server/index.js` — new route
- `src/components/SparkPage/GpuDailyChart.tsx` (new), wired into `GpuPanel.tsx`

**Note:** this tracks going forward from whenever the Spark unit is registered in
sparkDash. It does not backfill history from a pre-existing, separate
`thermal_monitor.log` (written by this fork's `spark-comfyui.sh status --watch`) —
that's a different tool with its own log file, not something sparkDash reads.

## 5. Native "Services" launcher tab

**Problem:** this deployment runs a growing stack (Open WebUI, Qwen/SGLang,
ComfyUI, n8n, sparkDash itself, plus internal-only Postgres/SearXNG/n8n Code
Sandbox) with no single place inside sparkDash to see what's up and jump to
it — just remembered ports and bookmarks.

**Fix:** a new "Services" tab, slotted into the exact same sentinel-id
machinery the existing "Overview" tab already uses (`OVERVIEW_ID` in
`src/constants.ts` → added `SERVICES_ID` alongside it, wired through
`useRoute.ts`, `SparkTabs.tsx`, `App.tsx`), so it's a first-class tab with its
own clean URL (`/services`), not a separate page or iframe.

- `config/services.json` (new, tracked in git): a small static manifest —
  id/name/category/port/description/probe-kind/actions — describing this
  fork's fixed service stack. Editable without touching any component.
- `server/collectors/ServicesProbe.js` (new): resolves each entry's live
  status per its probe kind. **sglang and ComfyUI reuse the existing
  `LlmProbe`/`ComfyProbe` output** (`spark.metrics.llm[]` / `spark.metrics.
  comfy`) instead of a second independent probe. Open WebUI and n8n get a
  fresh short-timeout `GET` (n8n's `/healthz`; Open WebUI a plain `GET /`
  since it was stopped at implementation time and its health endpoint
  couldn't be verified without starting it). Postgres/SearXNG/Sandbox are
  static `"internal"` — confirmed via `ss -tlnp` that sparkDash (which runs
  `network_mode: host`) has no network route to any of them at all, so this
  isn't a skipped probe, there's no path to probe. **No Docker socket
  involved anywhere** — confirmed absent from the container both before and
  after this change; container-state probing was considered and dropped, per
  the same "don't weaken security for a launcher" principle as everything
  else in this fork.
- New route `GET /api/sparks/:id/services`, request-driven like the existing
  `/gpu/daily` and `/llm/daily` routes rather than joining the WebSocket
  snapshot loop.
- `src/components/ServicesPage/{ServicesPage,ServiceCard}.tsx` (new): cards
  grouped into AI & Creative / Automation / Infrastructure / System, reusing
  the `.panel` card chrome and the Overview page's grid convention. Status
  chips use the existing `--color-success`/`--color-muted` tokens —
  deliberately not danger-red for "offline", since an intentionally-stopped
  ComfyUI (e.g. mid Coding-Mode) isn't a failure. Every Open/API/Metrics link
  is built from `spark.lanIp` (the same rule `ComfyPanel.tsx`'s
  `comfyOpenUrl()` already follows) — never `127.0.0.1`/`localhost` in a link
  rendered for the browser.
- New `LaunchIcon` in `ui/icons.tsx`, same minimal stroke-SVG style as every
  other icon here — no icon package added.

**Bug fixed along the way:** `useSnapshot.ts`'s WebSocket-driven `activeId`
reconciliation only special-cased `OVERVIEW_ID` as an always-valid non-Spark
id; every ~2s snapshot tick was silently bouncing the new Services tab back
to Overview. Added `SERVICES_ID` to that same check.

**Not implemented** (matches the scope of the request that drove this): no
Docker socket mount, no "Switch to Coding/Creative Mode" buttons, no
Start/Stop/Restart — no safe predefined-command execution path exists yet in
this fork, and none of it is stubbed in disabled either.

## 6. Real online/offline status for internal services

**Problem:** section 5's Services tab showed PostgreSQL/SearXNG/n8n Code
Sandbox with a static `"Internal"` label regardless of whether the
containers were actually running — if Postgres crashed, the dashboard would
keep saying "Internal" with no hint anything was wrong.

**Found, not introduced:** the sparkDash container can already reach the
host's real Docker Engine API. The existing `/host/root` read-only bind
mount (already there for the `nvidia-smi`/`/proc`/`/sys` fallback path) makes
`/host/root/run/docker.sock` reachable, and the container runs as root,
which matches the socket's owning uid — the read-only mount only blocks
writing *files* through it, not using a live socket for IPC. This is
inherited entirely from upstream's own container design (`privileged: true`,
`pid: host`, host-root mount); this fork didn't add it, it was already
sitting there. Flagged explicitly to the user before writing any code that
uses it, since a connection to that socket can issue *any* Docker Engine API
call (start/stop/exec/delete on every container on the box), not just reads.

**Fix**, after explicit confirmation this was wanted:

- `server/collectors/ServicesProbe.js`: a GET-only Docker API client
  (`dockerInspect()`) — inspects one named container's
  `.State.Running` / `.State.Health.Status` and maps to `online` /
  `offline` / `degraded`. No POST/DELETE/exec anywhere; documented inline
  as a hard boundary — this having *a* Docker API client is not license to
  grow it into container control later without a real conversation first.
- `config/services.json`: postgres/searxng/sandbox now use
  `"probe": "docker-container"` with a `"container"` name (`n8n-postgres`,
  `searxng`, `sandbox-api`), plus a new `"internal": true` flag that's
  independent of `status` — a service can be internal (no LAN UI, no
  port shown, no action buttons) *and* have a real online/offline/degraded
  state at the same time.
- `src/api/types.ts` / `ServiceCard.tsx`: `ServiceInfo.internal` replaces the
  old `status === "internal"` check, so the status chip now shows the real
  state while the "Internal only" treatment stays.

Verified against real container state, not just the happy path: all three
correctly show `online` (live Docker inspect data), and the `offline` path
was cross-checked against `sandbox-certs` — a container that's *supposed* to
exit after running once (`State.Running: false`) — without needing to stop
anything actually in use.

## Not changed

Everything else — ComfyUI monitoring, Hermes Agent, Tailnet probe, the sandbox stack
integration guidance, ports, Docker Compose shape — is unmodified upstream behavior.
