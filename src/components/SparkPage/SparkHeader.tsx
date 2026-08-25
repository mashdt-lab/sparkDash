import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { SparkActions } from "./SparkActions";
import { Sparkline } from "../ui/Sparkline";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface SparkHeaderProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return "<1m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

export function SparkHeader({ spark, onEdit }: SparkHeaderProps) {
  const { hardware } = spark;
  const online = spark.online;
  const hermes = spark.hermes;
  const cpu = spark.metrics?.cpu;
  const load1 = cpu?.loadAvg?.[0] ?? null;
  const loadHistory = useMetricsHistoryTail(spark.id, "cpu.loadavg1");
  const cores = hardware.cpuCores ?? 20;
  const loadSeverity =
    load1 == null ? "ok" : load1 > cores ? "danger" : load1 > cores * 0.8 ? "warning" : "ok";
  const loadBadgeClass =
    loadSeverity === "danger"
      ? "bg-danger/15 text-danger"
      : loadSeverity === "warning"
        ? "bg-warning/15 text-warning"
        : "bg-accent/15 text-accent";
  const loadLineColor =
    loadSeverity === "danger"
      ? "var(--color-danger)"
      : loadSeverity === "warning"
        ? "var(--color-warning)"
        : "var(--color-accent)";

  return (
    <div
      className="spark-header panel flex flex-wrap items-center gap-x-4 gap-y-2"
      style={{ padding: "var(--density-panel-pad)", ...(online ? {} : { opacity: 0.6 }) }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
          title={online ? "Online" : "Offline"}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text-strong">{spark.name}</h2>
            {(() => {
              const role = resolveSparkRole(spark);
              const text =
                role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
              const title =
                role === "head"
                  ? "Cluster head — local LLM API"
                  : role === "worker"
                    ? "Distributed LLM worker — no local model; LLM card is hidden"
                    : spark.llmMonitoring === false
                      ? "Standalone — LLM monitoring off"
                      : "Standalone — local LLM API";
              const workerLabel =
                role === "worker" ? spark.workerLabel?.trim() || null : null;
              return (
                <>
                  <span
                    className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                    title={title}
                  >
                    {text}
                  </span>
                  {workerLabel && (
                    <span
                      className="max-w-[14rem] truncate rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      title={workerLabel}
                    >
                      {workerLabel}
                    </span>
                  )}
                </>
              );
            })()}
            {online && spark.uptime != null && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-[10px] font-medium text-accent"
                title={`Uptime: ${formatUptime(spark.uptime)}`}
              >
                {formatUptime(spark.uptime)}
              </span>
            )}
            {hermes?.monitoring && hermes.installed && hermes.version && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-[10px] font-medium text-accent"
                title={`Hermes Agent ${hermes.version} installed on this machine`}
              >
                Hermes
              </span>
            )}
            {hermes?.monitoring && hermes.installed === false && hermes.checkedAt != null && (
              <span
                className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                title="The `hermes` binary was not found on this machine (check the install path or Edit Spark)."
              >
                Hermes not found
              </span>
            )}
            {hermes?.monitoring &&
              hermes.error &&
              hermes.status === "idle" && (
                <span
                  className="max-w-[16rem] shrink-0 truncate rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                  title={`Update check failed — it will retry automatically: ${hermes.error}`}
                >
                  Update check failed
                </span>
              )}
          </div>
          <p className="truncate text-xs text-muted">
            {hardware.gpuChip
              ? `${hardware.device} · ${hardware.gpuChip}${hardware.cudaDriver ? ` · Driver ${hardware.cudaDriver}` : ""}`
              : hardware.device}
          </p>
        </div>
      </div>

      {online && load1 != null && cpu?.loadAvg && (
        <div
          className={`hidden shrink-0 flex-col justify-center gap-1 rounded px-2.5 py-1.5 sm:flex ${loadBadgeClass}`}
          title={`Load average over the last 1 / 5 / 15 minutes, out of ${cores} CPU cores.`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-medium uppercase tracking-wide opacity-75">
              Load avg (1m · 5m · 15m)
            </span>
            <Sparkline data={loadHistory} color={loadLineColor} width={36} height={10} area={false} />
          </div>
          <span className="font-tabular text-xs font-semibold">
            {cpu.loadAvg.map((n) => n.toFixed(2)).join(" · ")}
          </span>
        </div>
      )}

      {/* Desktop action cluster (hidden on mobile; mobile renders its own row above Resources) */}
      <SparkActions
        spark={spark}
        onEdit={onEdit}
        className="ml-auto hidden flex-wrap items-center justify-end gap-2 sm:flex"
      />
    </div>
  );
}
