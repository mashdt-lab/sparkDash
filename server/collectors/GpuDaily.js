/**
 * Daily GPU temperature / power rollups.
 *
 * One series per Spark (not per-port — a Spark has one GPU). Samples are
 * recorded whenever the GPU collector returns a reading; there's no "busy"
 * gate like LlmDaily's decode/prefill (a GPU sitting idle at 45C is still a
 * real data point worth keeping, unlike a 0 tok/s LLM sample). Persists to
 * config/gpu-daily.json, last 30 UTC days — mirrors server/collectors/LlmDaily.js.
 */
import fs from "fs";
import { GPU_DAILY_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const MAX_DAYS = 30;
const FLUSH_MS = 30_000;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function emptyDay() {
  return {
    tempMax: 0,
    tempSum: 0,
    tempN: 0,
    powerMax: 0,
    powerSum: 0,
    powerN: 0,
  };
}

function ingest(day, field, value) {
  if (value == null || !Number.isFinite(value) || value <= 0) return false;
  const v = round1(value);
  day[`${field}Max`] = Math.max(day[`${field}Max`] || 0, v);
  day[`${field}Sum`] = round1((day[`${field}Sum`] || 0) + v);
  day[`${field}N`] = (day[`${field}N`] || 0) + 1;
  return true;
}

function avg(sum, n) {
  if (!n) return null;
  return round1(sum / n);
}

function publicDay(date, day) {
  if (!day) {
    return { date, tempMax: 0, tempAvg: null, powerMax: 0, powerAvg: null };
  }
  return {
    date,
    tempMax: round1(day.tempMax || 0),
    tempAvg: avg(day.tempSum, day.tempN),
    powerMax: round1(day.powerMax || 0),
    powerAvg: avg(day.powerSum, day.powerN),
  };
}

function pruneSeries(daysByDate) {
  const keys = Object.keys(daysByDate).sort();
  if (keys.length <= MAX_DAYS) return daysByDate;
  const keep = new Set(keys.slice(-MAX_DAYS));
  const next = {};
  for (const k of keys) {
    if (keep.has(k)) next[k] = daysByDate[k];
  }
  return next;
}

export class GpuDailyStore {
  /**
   * @param {string} [filePath]
   */
  constructor(filePath = GPU_DAILY_JSON_PATH) {
    this.filePath = filePath;
    /** @type {Record<string, Record<string, ReturnType<typeof emptyDay>>>} */
    this._data = {};
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object") this._data = raw;
    } catch {
      this._data = {};
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  flush() {
    if (!this._dirty) return;
    try {
      atomicWrite(this.filePath, JSON.stringify(this._data));
      this._dirty = false;
    } catch (err) {
      console.error("[GpuDaily] write failed:", err.message);
    }
  }

  /**
   * @param {string} sparkId
   * @param {{ temperature?: number, power?: { draw?: number } } | null} gpu
   * @param {Date} [now]
   */
  record(sparkId, gpu, now = new Date()) {
    if (!sparkId || !gpu) return;

    const date = utcDateKey(now);
    if (!this._data[sparkId]) this._data[sparkId] = {};
    if (!this._data[sparkId][date]) this._data[sparkId][date] = emptyDay();
    const day = this._data[sparkId][date];

    let changed = false;
    changed = ingest(day, "temp", gpu.temperature) || changed;
    changed = ingest(day, "power", gpu.power?.draw) || changed;

    if (!changed) return;
    this._data[sparkId] = pruneSeries(this._data[sparkId]);
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Calendar-aligned last `days` UTC dates (zeros for missing).
   * @param {string} sparkId
   * @param {{ days?: number, now?: Date }} [opts]
   */
  getSeries(sparkId, opts = {}) {
    const n = Math.min(MAX_DAYS, Math.max(1, Number(opts.days) || 14));
    const now = opts.now instanceof Date ? opts.now : new Date();
    const stored = this._data[sparkId] || {};
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const date = utcDateKey(d);
      out.push(publicDay(date, stored[date]));
    }
    return { sparkId, days: out };
  }
}

export const gpuDaily = new GpuDailyStore();
