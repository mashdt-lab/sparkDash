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
 *   docker-container-llm — like docker-container (below), for one of
 *                         several SGLang *profiles* that share a port at
 *                         different times; attaches the live LLM probe's
 *                         modelId as a workload label once confirmed online.
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
 * just reads — start/stop/exec/delete on every container on this box.
 *
 * 2026-08-26: extended, with explicit sign-off, to also issue POST
 * .../start and .../stop for a small, manifest-driven allowlist of named
 * containers (see performServiceAction below) — never restart, exec,
 * delete, create, or anything accepting a client-supplied image/command.
 * The set of controllable containers and their exclusivity groups (e.g.
 * "only one SGLang profile at a time") live entirely in config/services.json,
 * not in any request body, so the browser can only ever trigger one of the
 * pre-defined actions already listed there — never an arbitrary container
 * name or Docker API call.
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
    case "docker-container-llm": {
      // Ground truth is Docker itself, not the LLM probe's reported modelId
      // (which turned out to be the raw --model-path, not a stable id we'd
      // want to hardcode per profile) -- two SGLang profiles share port 8888
      // at different times, and only one container name is ever "Running".
      // Once confirmed online, still attach whatever the live LLM probe
      // reports as a workload label -- informational only.
      const status = await probeDockerContainer(entry.container);
      if (status !== "online") return { status };
      const idx = Array.isArray(sparkSnapshot.llmPorts)
        ? sparkSnapshot.llmPorts.indexOf(entry.port)
        : -1;
      const match =
        idx >= 0 && Array.isArray(sparkSnapshot.metrics?.llm)
          ? sparkSnapshot.metrics.llm[idx]
          : null;
      return { status, extra: match?.modelId ? { workload: match.modelId } : undefined };
    }
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
 * POST-only Docker Engine API call over the host's own docker.sock —
 * .../start or .../stop for one named container. Never called with a
 * container name that didn't come from config/services.json (see
 * performServiceAction).
 * @param {string} containerName
 * @param {"start" | "stop"} action
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
function dockerAction(containerName, action) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path: `/containers/${encodeURIComponent(containerName)}/${action}`,
        method: "POST",
        timeout: SERVICES_PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          // 204 = did it; 304 = already in that state -- both count as success.
          resolve({ ok: res.statusCode === 204 || res.statusCode === 304, status: res.statusCode });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

/**
 * Start or stop one controllable service by its manifest id. The only
 * inputs that matter are `serviceId` (must match a config/services.json
 * entry with `controllable: true`) and `action` -- never a container name
 * or Docker API path from the caller. For a service with an
 * `exclusiveGroup` (the two SGLang profiles share "sglang"), activating it
 * first stops every other member of that group, since only one large LLM
 * server runs on this box at a time.
 * @param {string} serviceId
 * @param {"activate" | "deactivate"} action
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function performServiceAction(serviceId, action) {
  if (action !== "activate" && action !== "deactivate") {
    return { ok: false, error: `unknown action "${action}"` };
  }
  const manifest = loadManifest();
  const entry = manifest.find((e) => e.id === serviceId);
  if (!entry || !entry.controllable || !entry.container) {
    return { ok: false, error: `"${serviceId}" is not a controllable service` };
  }

  if (action === "deactivate") {
    const r = await dockerAction(entry.container, "stop");
    if (r.ok) return { ok: true };
    return { ok: false, error: `docker stop failed (HTTP ${r.status})` };
  }

  if (entry.exclusiveGroup) {
    const others = manifest.filter(
      (e) => e.exclusiveGroup === entry.exclusiveGroup && e.id !== entry.id && e.container
    );
    for (const other of others) {
      await dockerAction(other.container, "stop");
    }
  }
  const r = await dockerAction(entry.container, "start");
  if (r.ok) return { ok: true };
  if (r.status === 404) {
    return {
      ok: false,
      error: `container "${entry.container}" doesn't exist yet — run its start.sh once on the host first`,
    };
  }
  return { ok: false, error: `docker start failed (HTTP ${r.status})` };
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
        controllable: Boolean(entry.controllable && entry.container),
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
