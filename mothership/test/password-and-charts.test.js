/** Unit tests lock password policy and deterministic chart bucketing. */

import assert from "node:assert/strict";
import test from "node:test";
import { bucketSeries, chartRange, renderLineChart } from "../src/lib/charts.js";
import { formatBytes, formatPercent, rollingAverage } from "../src/lib/format.js";
import { hashPassword, validatePassword, verifyPassword } from "../src/lib/password.js";

test("password policy accepts passphrases and rejects short values", async () => {
  assert.throws(() => validatePassword("1234567"), /8 characters/);
  const password = "12345678";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, "incorrect horse battery staple"), false);
});

test("chart ranges and buckets produce bounded averages", () => {
  const range = chartRange("24h");
  const base = Math.floor(Date.now() / range.bucketMs) * range.bucketMs;
  const points = bucketSeries([
    { observedAt: new Date(base), cpuPercent: 10 },
    { observedAt: new Date(base + 1000), cpuPercent: 30 },
    { observedAt: new Date(base + range.bucketMs), cpuPercent: 50 },
  ], "cpuPercent", range);
  assert.equal(points.length, 2);
  assert.equal(points[0].value, 20);
  const percentageChart = renderLineChart(points, "CPU");
  assert.match(percentageChart, /<svg/);
  assert.match(percentageChart, /0\.00%/);
  assert.match(percentageChart, /100\.00%/);
  assert.match(renderLineChart([{ name: "CPU average", points }, { name: "cpu0", points }], "CPU"), /chart-line-muted/);
  assert.equal(chartRange("7d").key, "7d");
});

test("shared operational formatting uses two-decimal percentages", () => {
  assert.equal(formatPercent(10.124141), "10.12%");
  assert.equal(formatBytes(1_572_864), "1.50 MB");
  assert.equal(rollingAverage([{ observedAt: new Date(), cpuPercent: 10 }, { observedAt: new Date(), cpuPercent: 20 }], "cpuPercent", 1_000), 15);
});
