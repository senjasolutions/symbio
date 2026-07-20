/**
 * Alert engine — runs on a timer in the mothership process, checks threshold rules
 * against server_statuses samples, and fires/resolves events with monit-style
 * state-transition notifications (matched / succeeded).
 *
 * Key behaviors:
 * - All samples within the duration window must exceed the threshold to fire.
 * - Fires on state transition only (not-firing → firing).
 * - Resolves when the latest sample drops below threshold.
 * - Sends Slack (and future channel) notifications on both fire and resolve.
 * - Fetches diagnostic process data from the agent bridge on fire.
 * - Enforces a per-rule cooldown to prevent notification spam.
 */

import { Op } from "sequelize";
import { models, sequelize } from "../db/index.js";
import { fetchTopProcesses } from "./system.service.js";
import { dispatchAlert } from "./notifications/index.js";
import { triggerHealSkill } from "./skills/scheduler.js";

let timer = null;
let running = false;

/** Starts the alert engine timer. Runs immediately on first call. */
export const startAlertEngine = async () => {
  if (running) return;
  running = true;
  await checkRules();
  timer = setInterval(checkRules, 30_000);
  timer.unref();
};

/** Stops the alert engine timer. */
export const stopAlertEngine = () => {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
};

/** Parses JSON defensively. */
const parseJson = (value, fallback) => {
  try { const parsed = JSON.parse(value || ""); return parsed ?? fallback; } catch { return fallback; }
};

/** Reads effective metric value from a ServerStatus row, computing derived fields. */
const readMetric = (status, rule) => {
  // Derived: swap_percent = swap_used / swap_total * 100
  if (rule.metricField === "swapPercent") {
    if (status.swapUsedBytes == null || !status.swapTotalBytes) return null;
    return (Number(status.swapUsedBytes) / Number(status.swapTotalBytes)) * 100;
  }
  // Direct column access
  const val = status[rule.metricField];
  if (val == null || !Number.isFinite(Number(val))) return null;
  return Number(val);
};

/** Gets the effective threshold, auto-calculating load thresholds from CPU cores. */
const effectiveThreshold = async (rule, serverId) => {
  if (rule.thresholdValue === 0 && rule.metricField?.startsWith?.("load")) {
    try {
      const server = await models.Server.findByPk(serverId);
      const hw = parseJson(server?.hardwareJson, {});
      const cores = hw.logicalCores || 4;
      // load_1: cores * 2, load_5: cores * 1.5, load_15: cores * 1
      if (rule.metricField === "load1") return cores * 2;
      if (rule.metricField === "load5") return cores * 1.5;
      if (rule.metricField === "load15") return cores * 1;
    } catch (e) { console.error("Failed to get effective threshold, using fallback:", e.message); return 8; }
  }
  return rule.thresholdValue;
};

/** Checks if value exceeds threshold given the operator. */
const exceedsThreshold = (value, threshold, operator) => {
  if (value == null) return false;
  if (operator === "gt") return value > threshold;
  if (operator === "lt") return value < threshold;
  return false;
};

/** Fetches process diagnostics relevant to the triggering metric field.
 *  CPU metrics → only top CPU processes. Memory/swap → only top memory.
 *  Load/AWS/IOWait → both. Disk/network → none (not meaningful). */
const fetchDiagnostics = async (rule) => {
  const mf = rule.metricField || "";
  const isCpu = mf.includes("cpu") || mf.includes("iowait") || mf.startsWith("load");
  const isMem = mf.includes("memory") || mf.includes("swap");
  if (!isCpu && !isMem) return null;
  try {
    const data = await fetchTopProcesses();
    const result = {};
    if (isCpu) result.topCpu = (data.topCpu || []).map(p => ({ pid: p.pid, name: p.name, command: p.command }));
    if (isMem) result.topMem = (data.topMem || []).map(p => ({ pid: p.pid, name: p.name, command: p.command, rss: p.rss }));
    return result;
  } catch { return null; }
};

/** Checks all enabled rules against the latest monitoring data. */
const checkRules = async () => {
  try {
    const rules = await models.AlertRule.findAll({ where: { enabled: true } });
    for (const rule of rules) {
      try { await checkRule(rule); } catch (e) { console.error("Alert rule check failed:", e.message); }
    }
  } catch (e) { console.error("Alert cycle failed:", e.message); }
};

/** Checks a single rule: evaluate threshold or status match, manage event lifecycle, notify on transitions. */
const checkRule = async (rule) => {
  // Branch: application or service resources use status-matching logic, not numeric thresholds
  if (rule.resource === "application") return checkAppRule(rule);
  if (rule.resource === "service") return checkServiceRule(rule);

  // Original numeric-threshold path for cpu, memory, swap, disk, load
  const effectiveThresh = await effectiveThreshold(rule, rule.serverId);
  const since = new Date(Date.now() - rule.durationSeconds * 1000);
  const samples = await models.ServerStatus.findAll({
    where: { serverId: rule.serverId, observedAt: { [Op.gte]: since } },
    order: [["observedAt", "DESC"]],
    raw: true,
  });
  if (!samples.length) return;
  const latest = samples[0];
  const currentValue = readMetric(latest, rule);
  if (currentValue == null) return;

  const latestEvent = await models.AlertEvent.findOne({
    where: { ruleId: rule.id },
    order: [["triggeredAt", "DESC"]],
    raw: true,
  });
  const isFiring = latestEvent?.status === "firing";
  const allExceeded = samples.every(s => {
    const val = readMetric(s, rule);
    return val != null && exceedsThreshold(val, effectiveThresh, rule.operator);
  });

  await handleTransition(rule, latestEvent, isFiring, allExceeded, {
    metricValue: currentValue,
    thresholdValue: effectiveThresh,
    observedAt: latest.observedAt,
  });
};

/** Checks an application-targeted rule against application_statuses within the duration window. */
const checkAppRule = async (rule) => {
  if (!rule.targetId) return;
  const since = new Date(Date.now() - rule.durationSeconds * 1000);
  const statusMatch = parseJson(rule.statusMatch, []);
  if (!statusMatch.length) return;

  const samples = await models.ApplicationStatus.findAll({
    where: { applicationId: rule.targetId, observedAt: { [Op.gte]: since } },
    order: [["observedAt", "DESC"]],
    raw: true,
  });
  if (!samples.length) return;

  const latest = samples[0];
  const latestEvent = await models.AlertEvent.findOne({
    where: { ruleId: rule.id },
    order: [["triggeredAt", "DESC"]],
    raw: true,
  });
  const isFiring = latestEvent?.status === "firing";

  // All samples in window must match one of the configured bad statuses
  const allBad = samples.every(s => statusMatch.includes(s.status));

  // Get app name for notification display
  const app = await models.Application.findByPk(rule.targetId, { raw: true });

  await handleTransition(rule, latestEvent, isFiring, allBad, {
    metricValue: 0,
    thresholdValue: 0,
    observedAt: latest.observedAt,
    statusText: latest.status,
    targetName: app?.displayName || app?.name || `App #${rule.targetId}`,
    statusMatch,
  });
};

/** Checks a service-targeted rule against server_service_statuses within the duration window. */
const checkServiceRule = async (rule) => {
  if (!rule.targetId) return;
  const since = new Date(Date.now() - rule.durationSeconds * 1000);
  const statusMatch = parseJson(rule.statusMatch, []);
  if (!statusMatch.length) return;

  const samples = await models.ServerServiceStatus.findAll({
    where: { serverServiceId: rule.targetId, observedAt: { [Op.gte]: since } },
    order: [["observedAt", "DESC"]],
    raw: true,
  });
  if (!samples.length) return;

  const latest = samples[0];
  const latestEvent = await models.AlertEvent.findOne({
    where: { ruleId: rule.id },
    order: [["triggeredAt", "DESC"]],
    raw: true,
  });
  const isFiring = latestEvent?.status === "firing";

  // All samples in window must match one of the configured bad statuses
  const allBad = samples.every(s => statusMatch.includes(s.status));

  // Get service name for notification display
  const svc = await models.ServerService.findByPk(rule.targetId, { raw: true });

  await handleTransition(rule, latestEvent, isFiring, allBad, {
    metricValue: 0,
    thresholdValue: 0,
    observedAt: latest.observedAt,
    statusText: latest.status,
    targetName: svc?.displayName || `Service #${rule.targetId}`,
    statusMatch,
  });
};

/** Unified transition handler: fires on not-firing→exceeded, resolves on firing→not-exceeded. */
const handleTransition = async (rule, latestEvent, isFiring, conditionMet, details) => {
  const now = new Date();
  const { metricValue, thresholdValue, observedAt, statusText, targetName, statusMatch } = details;

  if (conditionMet && !isFiring) {
    // Cooldown check
    if (latestEvent?.resolvedAt) {
      const resolvedAgo = now.getTime() - new Date(latestEvent.resolvedAt).getTime();
      if (resolvedAgo < rule.cooldownSeconds * 1000) return;
    }

    let diagnosticJson = null;
    if (rule.diagnosticEnabled && rule.resource !== "application" && rule.resource !== "service") {
      const diag = await fetchDiagnostics(rule);
      if (diag) diagnosticJson = JSON.stringify(diag);
    }

    await models.AlertEvent.create({
      ruleId: rule.id, serverId: rule.serverId,
      triggeredAt: observedAt, metricValue, thresholdValue,
      diagnosticJson, status: "firing",
    });

    const server = await models.Server.findByPk(rule.serverId);
    const hostname = server?.hostname || "main-server";

    await dispatchAlert(rule, {
      eventType: "firing",
      ruleName: rule.name,
      resource: rule.resource,
      metricField: rule.metricField,
      metricValue,
      thresholdValue,
      operator: rule.operator,
      hostname,
      triggeredAt: observedAt,
      diagnostic: diagnosticJson ? parseJson(diagnosticJson, null) : null,
      statusText,
      targetName,
      statusMatch,
    });

    // Self-healing: trigger the configured skill (e.g. storage-maid) fire-and-forget
    if (rule.healSkillKey) {
      triggerHealSkill(rule.healSkillKey).catch((err) =>
        console.error(`[alert-engine] Heal skill ${rule.healSkillKey} trigger failed:`, err.message)
      );
    }
  } else if (!conditionMet && isFiring) {
    if (latestEvent && latestEvent.status !== "acknowledged") {
      await models.AlertEvent.update(
        { status: "resolved", resolvedAt: new Date() },
        { where: { id: latestEvent.id } },
      );
    }

    const server = await models.Server.findByPk(rule.serverId);
    const hostname = server?.hostname || "main-server";

    await dispatchAlert(rule, {
      eventType: "resolved",
      ruleName: rule.name,
      resource: rule.resource,
      metricField: rule.metricField,
      metricValue,
      thresholdValue,
      operator: rule.operator,
      hostname,
      triggeredAt: observedAt,
      statusText,
      targetName,
    });
  }
};
