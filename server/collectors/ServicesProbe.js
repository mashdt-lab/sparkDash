/**
 * ServicesProbe — resolves the "Services" launcher tab's per-service status
 * from a static manifest (config/services.json) plus whatever the Spark's
 * own SparkMonitor already knows.
 *
 * Deliberately request-driven, not part of the WebSocket snapshot / poll
 * loop (see server/index.js's GET /api/sparks/:id/services) — mirrors how
 * /gpu/daily and /llm/daily are separate on-demand routes rather than fields
 * pushed on every WS tick.
 *
 * Probe kinds (from the manifest's "probe" field):
 *   reuse-llm          — read spark.metrics.llm[] (existing LlmProbe output);
 *                         no extra network call.
 *   reuse-comfy         — read spark.metrics.comfy (existing ComfyProbe output);
 *                         no extra network call.
 *   http-get            — fresh, short-timeout GET to 127.0.0.1:{port}{path}.
 *                         Always 127.0.0.1: this fork only ever runs against
 *                         the local Spark, and the sparkDash container shares
 *                         the host network namespace (network_mode: host) —
 *                         same reasoning as llmProbeHost().
 *   docker-container    — read-only GET to the Docker Engine API over the
 *                         host's own docker.sock, reachable at
 *                         /host/root/run/docker.sock through the *existing*
 *                         host-root bind mount (see DOCKER_SOCKET_PATH below
 *                         for the security note on why this path exists at
 *                         all and what it is/isn't scoped to).
 *   static-internal     — no probe attempted; always "internal" status.
 *                         Kept as a manifest option for any future entry
 *                         that has no resolvable container name.
 *   mirror-spark-online — tracks the Spark's own online/offline state.
 *   self                — this process is answering the request; always online.
 *
 * The manifest's "internal": true flag is independent of "probe" — it just
 * means "no LAN-facing UI for this service" (suppresses the port number in
 * favour of "Internal only", and openable/api/metrics links). A service can
 * be internal AND have a real online/offline/degraded status.
 *
 * Browser-facing openUrl is built from spark.lanIp (never 127.0.0.1/localhost),
 * matching ComfyPanel.tsx's comfyOpenUrl() convention.
 */
import fs from "fs";
import http from "http";
import { SERVICES_JSON_PATH, SERVICES_PROBE_TIMEOUT_MS } from "../config.js";

/**
 * SECURITY NOTE — read this before touching this constant or adding new
 * docker-container probes.
 *
 * This is NOT a socket mounted for this feature. sparkDash's docker-compose.yml
 * already bind-mounts the host's `/` read-only at /host/root (for nvidia-smi
 * fallback / host proc-and-sys access) and the container runs as root with
 * `privileged: true`. That combination happens to make the host's real
 * /run/docker.sock reachable and connectable here too — root inside the
 * container matches the socket's owning uid, so the read-only bind mount
 * does not block using it for IPC (it only blocks writing new files through
 * that mount path).
 *
 * A connection to this socket can issue ANY Docker Engine API call, not
 * just reads — start/stop/exec/delete on every container on this box. The
 * code below issues GET-only requests (container inspect) and nothing else.
 * Do not extend this to POST/DELETE without a real conversation about it
 * first — this file having *a* Docker API client does not mean this app
 * should gain container control.
 */
const DOCKER_SOCKET_PATH = "/host/root/run/docker.sock";

/** @type {Array<object> | null} */
let manifestCache = null;

function loadManifest() {
  if (manifestCache) return manifestCache;
  try {
    const raw = JSON.parse(fs.readFileSync(SERVICES_JSON_PATH, "utf8"));
    manifestCache = Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.error("[ServicesProbe] failed to load services.json:", err.message);
    manifestCache = [];
  }
  return manifestCache;
}

function lanHost(spark) {
  const ip = spark?.lanIp != null ? String(spark.lanIp).trim() : "";
  return ip || null;
}

function buildOpenUrl(spark, port, path) {
  const host = lanHost(spark);
  if (!host || !Number.isInteger(port)) return null;
  return `http://${host}:${port}${path || ""}`;
}

/**
 * @param {number} port
 * @param {string} [path]
 * @param {number} [timeoutMs]
 * @returns {Promise<"online" | "offline">}
 */
async function probeHttpGet(port, path = "/", timeoutMs = SERVICES_PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 400 ? "online" : "offline";
  } catch {
    return "offline";
  }
}

/**
 * GET-only Docker Engine API call over the host's own docker.sock.
 * @param {string} containerName
 * @returns {Promise<{ found: boolean, running?: boolean, health?: string | null, error?: boolean }>}
 */
function dockerInspect(containerName) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path: `/containers/${encodeURIComponent(containerName)}/json`,
        timeout: SERVICES_PROBE_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 404) return resolve({ found: false });
          if (res.statusCode !== 200) return resolve({ found: false, error: true });
          try {
            const data = JSON.parse(body);
            resolve({
              found: true,
              running: Boolean(data?.State?.Running),
              health: data?.State?.Health?.Status || null,
            });
          } catch {
            resolve({ found: false, error: true });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ found: false, error: true });
    });
    req.on("error", () => resolve({ found: false, error: true }));
  });
}

/**
 * @param {string} containerName
 * @returns {Promise<"online" | "offline" | "degraded" | "unknown">}
 */
async function probeDockerContainer(containerName) {
  if (!containerName) return "unknown";
  const state = await dockerInspect(containerName);
  if (state.error) return "unknown";
  if (!state.found || !state.running) return "offline";
  if (state.health === "unhealthy") return "degraded";
  return "online";
}

/**
 * @param {object} entry service manifest entry
 * @param {object} sparkSnapshot result of SparkMonitor.snapshot()
 * @returns {Promise<{ status: string, extra?: object }>}
 */
async function resolveStatus(entry, sparkSnapshot) {
  switch (entry.probe) {
    case "reuse-llm": {
      // metrics.llm[] lines up 1:1 with the Spark's own llmPorts[] (same
      // index — see SparkMonitor's per-port LlmProbe map), so match this
      // manifest entry's port by position rather than assuming the metric
      // object itself carries a "port" field.
      const idx = Array.isArray(sparkSnapshot.llmPorts)
        ? sparkSnapshot.llmPorts.indexOf(entry.port)
        : -1;
      const match =
        idx >= 0 && Array.isArray(sparkSnapshot.metrics?.llm)
          ? sparkSnapshot.metrics.llm[idx]
          : null;
      return {
        status: match?.available ? "online" : "offline",
        extra: match?.modelId ? { workload: match.modelId } : undefined,
      };
    }
    case "reuse-comfy": {
      const comfy = sparkSnapshot.metrics?.comfy;
      return { status: comfy?.available ? "online" : "offline" };
    }
    case "http-get": {
      if (!Number.isInteger(entry.port)) return { status: "offline" };
      return { status: await probeHttpGet(entry.port, entry.path || "/") };
    }
    case "docker-container":
      return { status: await probeDockerContainer(entry.container) };
    case "static-internal":
      return { status: "internal" };
    case "mirror-spark-online":
      return { status: sparkSnapshot.online ? "online" : "offline" };
    case "self":
      return { status: "online" };
    default:
      return { status: "unknown" };
  }
}

/**
 * @param {object} sparkSnapshot result of SparkMonitor.snapshot()
 * @returns {Promise<Array<object>>}
 */
export async function getServicesSnapshot(sparkSnapshot) {
  const manifest = loadManifest();
  return Promise.all(
    manifest.map(async (entry) => {
      const { status, extra } = await resolveStatus(entry, sparkSnapshot);
      const openUrl = entry.openable ? buildOpenUrl(sparkSnapshot, entry.port, "/") : null;
      const apiUrl =
        entry.actions?.includes("api") && entry.port
          ? buildOpenUrl(sparkSnapshot, entry.port, "/v1/models")
          : null;
      const metricsUrl =
        entry.actions?.includes("metrics") && entry.port
          ? buildOpenUrl(sparkSnapshot, entry.port, "/metrics")
          : null;
      return {
        id: entry.id,
        name: entry.name,
        category: entry.category,
        description: entry.description,
        port: entry.port ?? null,
        status,
        internal: Boolean(entry.internal),
        openUrl,
        apiUrl,
        metricsUrl,
        copySsh: entry.actions?.includes("copy-ssh")
          ? `ssh ${entry.sshUser || "user"}@${lanHost(sparkSnapshot) || sparkSnapshot.id}`
          : null,
        ...extra,
      };
    })
  );
}
