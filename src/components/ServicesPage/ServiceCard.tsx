import { useState, type MouseEvent } from "react";
import type { ServiceInfo, ServiceStatus } from "../../api/types";
import { ActivityIcon, BotIcon, ComfyIcon, ExternalLinkIcon } from "../ui/icons";

function ServiceIcon({ id, className }: { id: string; className: string }) {
  if (id === "comfyui") return <ComfyIcon className={className} />;
  if (id.startsWith("sglang") || id === "open-webui") return <BotIcon className={className} />;
  return <ActivityIcon className={className} />;
}

const STATUS_LABEL: Record<ServiceStatus, string> = {
  online: "Online",
  offline: "Offline",
  degraded: "Degraded",
  internal: "Internal",
  unknown: "Unknown",
};

const STATUS_CLASS: Record<ServiceStatus, string> = {
  online: "bg-success/15 text-success",
  offline: "bg-muted/15 text-muted",
  degraded: "bg-warning/15 text-warning",
  internal: "bg-muted/15 text-muted",
  unknown: "bg-muted/15 text-muted",
};

function StatusChip({ status }: { status: ServiceStatus }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function openInNewTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ServiceCard({
  service,
  onAction,
}: {
  service: ServiceInfo;
  onAction?: (serviceId: string, action: "activate" | "deactivate") => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isOn = service.status === "online" || service.status === "degraded";

  const handleToggle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onAction || pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onAction(service.id, isOn ? "deactivate" : "activate");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const handleOpen = (e: MouseEvent, url: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (url) openInNewTab(url);
  };

  const handleCopySsh = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!service.copySsh) return;
    try {
      await navigator.clipboard.writeText(service.copySsh);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) -- nothing safe to
      // fall back to here; the command is still shown in the title attribute.
    }
  };

  const isInternal = service.internal;

  return (
    <div
      className="panel flex flex-col gap-2"
      style={{ padding: "var(--density-panel-pad)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ServiceIcon id={service.id} className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate text-sm font-semibold text-text-strong">
            {service.name}
          </span>
        </div>
        <StatusChip status={service.status} />
      </div>

      <p className="text-xs text-muted">{service.description}</p>

      {service.workload && (
        <p className="truncate font-tabular text-[11px] text-text" title={service.workload}>
          {service.workload}
          {typeof service.tokensPerSecond === "number" && (
            <span className="text-muted"> · {service.tokensPerSecond.toFixed(0)} tok/s</span>
          )}
        </p>
      )}

      {actionError && (
        <p className="text-[11px] text-danger" title={actionError}>
          {actionError}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="font-tabular text-[11px] text-muted">
          {isInternal ? "Internal only" : service.port != null ? `:${service.port}` : "—"}
        </span>
        <div className="flex items-center gap-1.5">
          {service.openUrl && (
            <button
              type="button"
              onClick={(e) => handleOpen(e, service.openUrl)}
              className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] text-text hover:bg-accent-soft hover:text-accent transition-colors"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              Open
            </button>
          )}
          {service.apiUrl && (
            <button
              type="button"
              onClick={(e) => handleOpen(e, service.apiUrl)}
              title="Open the OpenAI-compatible /v1/models endpoint (raw JSON, not a UI)"
              className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] text-text hover:bg-accent-soft hover:text-accent transition-colors"
            >
              API
            </button>
          )}
          {service.metricsUrl && (
            <button
              type="button"
              onClick={(e) => handleOpen(e, service.metricsUrl)}
              title="Open the Prometheus /metrics endpoint (raw text, not a UI)"
              className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] text-text hover:bg-accent-soft hover:text-accent transition-colors"
            >
              Metrics
            </button>
          )}
          {service.copySsh && (
            <button
              type="button"
              onClick={handleCopySsh}
              title={service.copySsh}
              className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-[11px] text-text hover:bg-accent-soft hover:text-accent transition-colors"
            >
              {copied ? "Copied" : "Copy SSH command"}
            </button>
          )}
          {service.controllable && onAction && (
            <button
              type="button"
              onClick={handleToggle}
              disabled={pending}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-60 ${
                isOn
                  ? "border-border bg-surface-elevated text-text hover:bg-danger/10 hover:text-danger"
                  : "border-accent/40 bg-accent-soft text-accent hover:bg-accent/20"
              }`}
            >
              {pending ? "…" : isOn ? "Deactivate" : "Activate"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
