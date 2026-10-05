/** Persistent generated-token odometer from backend cumulative counters. */
import fs from "fs";
import { LLM_TOKEN_TOTALS_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const TIME_ZONE = "Asia/Bangkok";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

function dateKey(date) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export class LlmTokenTotalsStore {
  constructor(filePath = LLM_TOKEN_TOTALS_PATH) {
    this.filePath = filePath;
    this.data = { startedAt: null, counters: {}, days: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (saved && typeof saved === "object") {
        this.data = {
          startedAt: saved.startedAt || null,
          counters: saved.counters || {},
          days: saved.days || {},
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") console.error("[LlmTokenTotals] load failed:", err.message);
    }
  }

  record(sparkId, port, metrics, now = new Date()) {
    const value = metrics?.totalOutputTokens;
    if (!sparkId || !Number.isInteger(port) || !metrics?.available ||
        !Number.isSafeInteger(value) || value < 0) return;
    const key = `${sparkId}:${port}`;
    const source = `${metrics.backend || "unknown"}:${metrics.modelId || "unknown"}`;
    const previous = this.data.counters[key];
    // A fresh source or a lower counter means the engine restarted. Establish a
    // new baseline; only observed positive deltas are assigned to a calendar day.
    const delta = previous?.source === source && value >= previous.value
      ? value - previous.value : 0;
    if (!previous && !this.data.startedAt) this.data.startedAt = now.toISOString();
    if (delta > 0) {
      const day = dateKey(now);
      if (!this.data.days[sparkId]) this.data.days[sparkId] = {};
      this.data.days[sparkId][day] = (this.data.days[sparkId][day] || 0) + delta;
    }
    if (!previous || previous.value !== value || previous.source !== source || delta > 0) {
      this.data.counters[key] = { source, value };
      this.flush();
    }
  }

  getTotals(sparkId, now = new Date()) {
    const today = dateKey(now);
    const days = this.data.days[sparkId] || {};
    let day = 0, month = 0, year = 0, allTime = 0;
    for (const [date, value] of Object.entries(days)) {
      if (!Number.isSafeInteger(value) || value < 0) continue;
      allTime += value;
      if (date === today) day += value;
      if (date.slice(0, 7) === today.slice(0, 7)) month += value;
      if (date.slice(0, 4) === today.slice(0, 4)) year += value;
    }
    return { sparkId, timeZone: TIME_ZONE, startedAt: this.data.startedAt,
      day, month, year, allTime };
  }

  flush() {
    try { atomicWrite(this.filePath, JSON.stringify(this.data)); }
    catch (err) { console.error("[LlmTokenTotals] write failed:", err.message); }
  }
}

export const llmTokenTotals = new LlmTokenTotalsStore();
