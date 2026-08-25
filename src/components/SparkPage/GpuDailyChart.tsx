import { useEffect, useState } from "react";
import { fetchGpuDaily } from "../../api/client";
import type { GpuDailyDay } from "../../api/types";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;
// Severity thresholds match the live GPU-temp bar elsewhere in this panel.
const WARN_C = 80;
const DANGER_C = 90;

function fmt(n: number | null | undefined, unit: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}${unit}`;
}

function barColor(tempMax: number): string {
  if (tempMax >= DANGER_C) return "var(--color-danger)";
  if (tempMax >= WARN_C) return "var(--color-warning)";
  return "var(--color-accent)";
}

export function GpuDailyChart({ sparkId }: { sparkId: string }) {
  const [days, setDays] = useState<GpuDailyDay[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchGpuDaily(sparkId, 14)
        .then((res) => {
          if (!cancelled) setDays(res.days || []);
        })
        .catch(() => {
          if (!cancelled) setDays([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId]);

  if (!days || days.length === 0) return null;

  const tempVals = days.map((d) => d.tempMax || 0);
  const max = Math.max(1, DANGER_C, ...tempVals);
  const n = days.length;
  const gap = 1.5;
  const barW = Math.max(2, CHART_W / n - gap);

  const hasData = days.some((d) => (d.tempMax || 0) > 0);

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          Daily peak temp
        </span>
        <span className="text-[10px] text-muted">°C · 14d</span>
      </div>
      {!hasData ? (
        <p className="text-[10px] text-muted">No samples in the last 14 days.</p>
      ) : (
        <svg
          width={CHART_W}
          height={CHART_H}
          className="block max-w-full"
          role="img"
          aria-label="Daily peak GPU temperature"
        >
          {days.map((d, i) => {
            const x0 = i * (barW + gap);
            const tempH = ((d.tempMax || 0) / max) * (CHART_H - 2);
            const title = [
              d.date,
              `temp peak ${fmt(d.tempMax, "°C")} (avg ${fmt(d.tempAvg, "°C")})`,
              `power peak ${fmt(d.powerMax, "W")} (avg ${fmt(d.powerAvg, "W")})`,
            ].join(" · ");
            return (
              <g key={d.date}>
                <title>{title}</title>
                <rect
                  x={x0}
                  y={CHART_H - tempH}
                  width={barW}
                  height={tempH}
                  fill={barColor(d.tempMax || 0)}
                  opacity={0.9}
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
