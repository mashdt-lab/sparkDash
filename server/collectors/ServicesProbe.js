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
 *   static-internal     — no network path exists (confirmed: these services
 *                         aren't published on the host at all), so no probe
 *                         is attempted; always "internal".
 *   mirror-spark-online — tracks the Spark's own online/offline state.
 *   self                — this process is answering the request; always online.
 *
 * Browser-facing openUrl is built from spark.lanIp (never 127.0.0.1/localhost),
 * matching ComfyPanel.tsx's comfyOpenUrl() convention.
 */
import fs from "fs";
import { SERVICES_JSON_PATH, SERVICES_PROBE_TIMEOUT_MS } from "../config.js";

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
