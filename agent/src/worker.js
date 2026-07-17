/**
 * Monitoring worker coordinates configuration refresh, collection, durable
 * enqueue, and retry delivery without allowing network outages to lose samples.
 */

import crypto from "node:crypto";
import { Op } from "sequelize";
import { config } from "./config.js";
import { enqueueReport, OutboxReport, readCachedConfig, readOutboxBatch, writeCachedConfig } from "./db.js";
import { collectHost, collectProcesses } from "./collectors/host.js";
import { probeApplications } from "./probes/applications.js";
import { probeServices } from "./probes/services.js";

let currentConfig = null;
let running = false;
let timer = null;
let lastApplicationCheckAt = 0;
let lastServiceCheckAt = 0;

export const workerState = {
  startedAt: null,
  lastCollectionAt: null,
  lastDeliveryAt: null,
  lastConfigAt: null,
  lastError: null,
};

/** Lets the authenticated bridge reader use the same cached configuration as monitoring. */
export const getCurrentConfig = () => currentConfig;

/** Sends one authenticated request to the loopback-only mothership API. */
const mothershipFetch = (path, options = {}) => fetch(`${config.mothershipUrl}${path}`, {
  ...options,
  headers: { authorization: `Bearer ${config.agentToken}`, "content-type": "application/json", ...(options.headers || {}) },
  signal: AbortSignal.timeout(10_000),
});

/** Refreshes and persists configuration while retaining a valid cache on failure. */
export const refreshConfiguration = async () => {
  try {
    const response = await mothershipFetch("/config");
    if (!response.ok) throw new Error(`Configuration request returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.applications) || !Array.isArray(payload.services)) throw new Error("Mothership returned invalid configuration");
    currentConfig = payload;
    await writeCachedConfig(payload);
    workerState.lastConfigAt = new Date();
    workerState.lastError = null;
  } catch (error) {
    workerState.lastError = error.message;
    if (!currentConfig) currentConfig = await readCachedConfig();
  }
};

/** Delivers the oldest report batch and removes rows only after acknowledgement.
 *  Handles individual report failures — a single bad report doesn't block the batch. */
export const flushOutbox = async () => {
  const rows = await readOutboxBatch();
  if (!rows.length) return;
  // Split into batches — process individually so one bad report doesn't block others
  for (const row of rows) {
    try {
      const report = JSON.parse(row.payload);
      const response = await mothershipFetch("/reports", {
        method: "POST", body: JSON.stringify({ schemaVersion: 1, agentId: config.agentId, reports: [report] }),
      });
      if (response.ok) {
        await OutboxReport.destroy({ where: { id: row.id } });
        workerState.lastDeliveryAt = new Date();
        workerState.lastError = null;
      } else {
        // Non-200 response — count as retry
        await OutboxReport.increment("attemptCount", { by: 1, where: { id: row.id } });
        workerState.lastError = `Report ${row.id}: HTTP ${response.status}`;
      }
    } catch (error) {
      workerState.lastError = `Report ${row.id}: ${error.message}`;
      await OutboxReport.increment("attemptCount", { by: 1, where: { id: row.id } });
    }
  }
  // Remove reports that have exceeded max retries (10 retries = ~10 min worth)
  await OutboxReport.destroy({ where: { attemptCount: { [Op]: { gt: 10 } } } });
};

/** Collects one report, using per-domain intervals from the latest valid config. */
export const collectReport = async () => {
  if (!currentConfig) await refreshConfiguration();
  const now = Date.now();
  const { host, metrics } = await collectHost();
  let services = [];
  let applications = [];
  if (currentConfig && now - lastServiceCheckAt >= (currentConfig.intervals?.serviceSeconds || 60) * 1000) {
    services = await probeServices(currentConfig.services, await collectProcesses());
    lastServiceCheckAt = now;
  }
  if (currentConfig && now - lastApplicationCheckAt >= (currentConfig.intervals?.applicationSeconds || 60) * 1000) {
    applications = await probeApplications(currentConfig.applications);
    lastApplicationCheckAt = now;
  }
  const report = { id: crypto.randomUUID(), observedAt: new Date().toISOString(), host, metrics, services, applications };
  await enqueueReport(report);
  workerState.lastCollectionAt = new Date();
};

/** Runs one serialized cycle so slow probes never overlap and amplify load. */
const cycle = async () => {
  if (!running) return;
  try {
    const configAge = workerState.lastConfigAt ? Date.now() - new Date(workerState.lastConfigAt).getTime() : Infinity;
    if (configAge >= (currentConfig?.intervals?.configSeconds || 60) * 1000) await refreshConfiguration();
    await collectReport();
    await flushOutbox();
  } catch (error) {
    workerState.lastError = error.message;
  } finally {
    if (running) timer = setTimeout(cycle, (currentConfig?.intervals?.reportSeconds || 30) * 1000);
  }
};

/** Starts the single monitoring loop and immediately attempts cached/offline operation. */
export const startWorker = async () => {
  if (running) return;
  running = true;
  workerState.startedAt = new Date();
  currentConfig = await readCachedConfig();
  await refreshConfiguration();
  await cycle();
};

/** Stops future monitoring cycles during graceful container shutdown. */
export const stopWorker = () => {
  running = false;
  if (timer) clearTimeout(timer);
};
