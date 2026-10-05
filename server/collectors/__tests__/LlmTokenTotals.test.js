import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmTokenTotalsStore } from "../LlmTokenTotals.js";

test("token odometer survives reload, calendar boundaries, and engine reset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-totals-"));
  const file = path.join(dir, "totals.json");
  const store = new LlmTokenTotalsStore(file);
  const metric = (totalOutputTokens) => ({ available: true, backend: "vllm", modelId: "a", totalOutputTokens });
  store.record("spark", 8888, metric(100), new Date("2026-09-30T16:58:00Z"));
  store.record("spark", 8888, metric(125), new Date("2026-09-30T16:59:00Z"));
  store.record("spark", 8888, metric(130), new Date("2026-09-30T17:01:00Z"));
  store.record("spark", 8888, metric(2), new Date("2026-09-30T17:02:00Z"));
  store.record("spark", 8888, metric(12), new Date("2026-09-30T17:03:00Z"));
  const reopened = new LlmTokenTotalsStore(file);
  assert.deepEqual(
    (({ day, month, year, allTime }) => ({ day, month, year, allTime }))
      (reopened.getTotals("spark", new Date("2026-09-30T17:05:00Z"))),
    { day: 15, month: 15, year: 40, allTime: 40 }
  );
  reopened.record("spark", 8888, metric(20), new Date("2026-09-30T17:06:00Z"));
  assert.equal(reopened.getTotals("spark").allTime, 48);
});

test("unavailable readings and source switches do not add phantom tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-totals-"));
  const store = new LlmTokenTotalsStore(path.join(dir, "totals.json"));
  store.record("spark", 8888, { available: false, totalOutputTokens: 900 });
  store.record("spark", 8888, { available: true, backend: "vllm", modelId: "a", totalOutputTokens: 10 });
  store.record("spark", 8888, { available: true, backend: "sglang", modelId: "b", totalOutputTokens: 100 });
  assert.equal(store.getTotals("spark").allTime, 0);
});
