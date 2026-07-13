/**
 * Agent reporting service validates the private contract, persists each report
 * transactionally, and treats report IDs as idempotency keys.
 */

import crypto from "node:crypto";
import { Op } from "sequelize";
import { config } from "../config.js";
import { models, sequelize } from "../db/index.js";

/** Compares bearer tokens in constant time after normalizing lengths. */
export const validAgentToken = (authorization) => {
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!config.agentToken || supplied.length !== config.agentToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(config.agentToken));
};

/** Parses stored adapter configuration without allowing malformed JSON to break config polling. */
const parseConfiguration = (value) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Serializes bounded inventory arrays so an agent cannot grow the SQLite row without limit. */
const inventoryJson = (value, maximumItems = 128) => {
  if (!Array.isArray(value) && (!value || typeof value !== "object")) return null;
  const safe = Array.isArray(value) ? value.slice(0, maximumItems) : value;
  const encoded = JSON.stringify(safe);
  return encoded.length <= 64 * 1024 ? encoded : null;
};

/** Builds the complete, credential-free configuration consumed by the local agent. */
export const buildAgentConfig = async () => {
  const [agent, applications, services, applicationLogs] = await Promise.all([
    models.Agent.findOne({ where: { agentKey: "main-agent" } }),
    models.Application.findAll({ order: [["id", "ASC"]] }),
    models.ServerService.findAll({ order: [["id", "ASC"]] }),
    models.ApplicationLog.findAll({ order: [["id", "ASC"]] }),
  ]);
  return {
    schemaVersion: 1,
    version: agent?.lastConfigVersion || 1,
    intervals: { reportSeconds: 30, applicationSeconds: 60, serviceSeconds: 60, configSeconds: 60 },
    applications: applications.map((application) => ({
      id: application.id,
      url: application.healthCheckUrl,
      timeoutMs: application.healthCheckTimeoutMs,
      slowThresholdMs: application.slowThresholdMs,
      responseTextMatch: application.responseTextMatch || "",
    })),
    services: services.map((service) => ({
      id: service.id,
      type: service.type,
      enabled: service.enabled,
      configuration: parseConfiguration(service.configuration),
    })),
    // Optional records preserve the existing schemaVersion=1 cached-config contract.
    applicationLogs: applicationLogs.map((log) => ({ id: log.id, applicationId: log.applicationId, filePath: log.filePath, tailLines: log.tailLines })),
  };
};

/** Inserts one never-before-seen report and every included sample atomically. */
const persistReport = async (agent, report) => {
  if (!report || typeof report.id !== "string" || report.id.length > 120) throw new Error("Invalid report ID.");
  const observedAt = new Date(report.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid report timestamp.");
  const existing = await models.AgentReport.findByPk(report.id);
  if (existing) return false;
  const receivedAt = new Date();

  await sequelize.transaction(async (transaction) => {
    await models.AgentReport.create({ id: report.id, agentId: agent.id, observedAt, receivedAt }, { transaction });
    if (report.host && typeof report.host === "object") {
      const inventory = {
        hostname: String(report.host.hostname || "").slice(0, 255) || null,
        primaryIp: String(report.host.primaryIp || "").slice(0, 64) || null,
        operatingSystem: String(report.host.operatingSystem || "").slice(0, 255) || null,
        kernelVersion: String(report.host.kernelVersion || "").slice(0, 255) || null,
        hardwareJson: inventoryJson(report.host.hardware, 1),
        storageJson: inventoryJson(report.host.storage),
        networkJson: inventoryJson(report.host.networking),
      };
      // Sparse reports from an older queued agent must not erase last known inventory.
      for (const [key, value] of Object.entries(inventory)) if (value == null) delete inventory[key];
      await models.Server.update(inventory, { where: { id: agent.serverId }, transaction });
    }
    if (report.metrics && typeof report.metrics === "object") {
      const cpuCoresJson = inventoryJson(report.metrics.cpuCores, 512);
      await models.ServerStatus.create({
        serverId: agent.serverId,
        reportId: report.id,
        ...report.metrics,
        ...(cpuCoresJson ? { cpuCoresJson } : {}),
        observedAt,
        receivedAt,
      }, { transaction });
    }
    for (const status of Array.isArray(report.services) ? report.services : []) {
      if (!Number.isInteger(Number(status.serviceId))) continue;
      await models.ServerServiceStatus.create({
        serverServiceId: Number(status.serviceId), reportId: report.id,
        status: status.status, evidence: String(status.evidence || "unknown").slice(0, 32),
        description: String(status.description || "").slice(0, 500) || null,
        responseTimeMs: Number.isFinite(Number(status.responseTimeMs)) ? Number(status.responseTimeMs) : null,
        observedAt,
      }, { transaction });
    }
    for (const status of Array.isArray(report.applications) ? report.applications : []) {
      if (!Number.isInteger(Number(status.applicationId))) continue;
      await models.ApplicationStatus.create({
        applicationId: Number(status.applicationId), reportId: report.id,
        status: status.status, statusCode: status.statusCode ?? null,
        responseTimeMs: status.responseTimeMs ?? null,
        finalUrl: String(status.finalUrl || "").slice(0, 1000) || null,
        failureReason: String(status.failureReason || "").slice(0, 500) || null,
        observedAt,
      }, { transaction });
    }
    agent.lastSeenAt = receivedAt;
    await agent.save({ transaction });
  });
  return true;
};

/** Validates a bounded report batch and returns inserted versus duplicate counts. */
export const ingestReportBatch = async (payload) => {
  if (!payload || payload.schemaVersion !== 1 || payload.agentId !== "main-agent") throw new Error("Unsupported agent payload.");
  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  if (reports.length < 1 || reports.length > 100) throw new Error("Report batch must contain between 1 and 100 reports.");
  const agent = await models.Agent.findOne({ where: { agentKey: payload.agentId } });
  if (!agent) throw new Error("Unknown agent.");
  let inserted = 0;
  for (const report of reports) inserted += await persistReport(agent, report) ? 1 : 0;
  return { inserted, duplicates: reports.length - inserted };
};

/** Removes expired histories and report receipts in dependency-safe order. */
export const cleanupHistory = async () => {
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
  await models.ServerStatus.destroy({ where: { observedAt: { [Op.lt]: cutoff } } });
  await models.ServerServiceStatus.destroy({ where: { observedAt: { [Op.lt]: cutoff } } });
  await models.ApplicationStatus.destroy({ where: { observedAt: { [Op.lt]: cutoff } } });
  await models.AgentReport.destroy({ where: { receivedAt: { [Op.lt]: cutoff } } });
};
