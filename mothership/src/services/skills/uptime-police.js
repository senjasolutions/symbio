/**
 * Uptime Police skill — continuously monitors service health. Runs lightweight
 * checks every 30s, only calling the LLM when an anomaly is detected.
 * Auto-restarts frozen services if safe.
 */

import { collectSkillData } from "../agent-client.js";
import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "uptime-police";

/** In-memory state: tracks last N checks per service for anomaly detection. */
const checkHistory = new Map();
const ANOMALY_THRESHOLD = 3;

const MONITORED_SERVICES = ["nginx", "apache2", "mysql", "postgresql", "redis-server", "docker", "pm2"];

const SYSTEM_PROMPT = `A service is DOWN/SLOW on a Linux server. Based on the evidence below, determine if it is safe to restart.

Also provide a "pattern" key for deduplication (the service name, e.g. "nginx").

Respond ONLY with valid JSON:
{
  "service": "nginx",
  "pattern": "nginx",
  "genuinelyFrozen": true,
  "safeToRestart": true,
  "riskLevel": "low",
  "recommendedAction": "restart" | "wait" | "manual-investigation",
  "urgency": "low" | "medium" | "high",
  "memory": "Optional note for future runs about this service pattern"
}`;

export default {
  id: SKILL_KEY,

  async collect(agentClient, config) {
    const services = Array.isArray(config.monitoredServices) ? config.monitoredServices : MONITORED_SERVICES;
    return agentClient.collectSkillData(["service-status"], { services });
  },

  async filter(collected) {
    const services = collected.serviceStatus?.services || [];
    const anomalies = [];
    for (const svc of services) {
      const key = svc.name;
      if (!checkHistory.has(key)) checkHistory.set(key, []);
      const history = checkHistory.get(key);
      history.push(svc.isActive !== "active");
      if (history.length > ANOMALY_THRESHOLD) history.shift();
      const failures = history.filter(Boolean).length;
      if (failures >= ANOMALY_THRESHOLD) anomalies.push(key);
    }
    if (!anomalies.length) return false;
    this._anomalies = anomalies;
    this._serviceData = services;
    // Prune stale entries (keep only services that still exist)
    const activeServices = new Set(services.map(s => s.name));
    for (const key of checkHistory.keys()) {
      if (!activeServices.has(key)) checkHistory.delete(key);
    }
    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    this._capturedMemory = null;
    const anomalies = this._anomalies || [];
    const services = this._serviceData || collected.serviceStatus?.services || [];
    if (!anomalies.length) return { findings: [], summary: "All services healthy." };

    const findings = [];
    let usageAgg = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const name of anomalies.slice(0, 3)) {
      const svc = services.find((s) => s.name === name) || {};
      const evidence = [
        `Service: ${name}`,
        `systemctl status: ${svc.isActive || "unknown"}`,
        `process detected: ${svc.processDetected}`,
      ].join("\n");

      const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "");

      const result = await callSkillAI({
        provider: llmConfig.provider, apiKey: llmConfig.apiKey,
        endpoint: llmConfig.endpoint, model: llmConfig.model,
        systemPrompt, dataContent: evidence, maxTokens: 1024,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
      });

      if (result.error) {
        findings.push({ severity: "critical", source: name, message: result.error, isSimpleFix: false });
        continue;
      }

      // Aggregate token usage across each per-anomaly LLM call
      if (result.usage) {
        usageAgg.promptTokens += result.usage.promptTokens || 0;
        usageAgg.completionTokens += result.usage.completionTokens || 0;
        usageAgg.totalTokens += result.usage.totalTokens || 0;
      }

      try {
        const parsed = JSON.parse(result.content);
        findings.push({
          severity: parsed.urgency === "high" ? "critical" : "warning",
          source: name,
          message: `Service ${name} is ${svc.isActive} — ${parsed.recommendedAction || "unknown"}`,
          probableCause: parsed.reasoning || "",
          pattern: parsed.pattern || name,
          suggestedFix: parsed.safeToRestart ? "systemctl.restart" : "",
          isSimpleFix: parsed.safeToRestart && parsed.recommendedAction === "restart",
        });
        // Capture memory from first anomaly only
        if (parsed.memory && !this._capturedMemory) {
          this._capturedMemory = parsed.memory;
        }
      } catch {
        findings.push({ severity: "warning", source: name, message: "Failed to parse LLM response", isSimpleFix: false });
      }
    }
    const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
    const filteredFindings = ignorePatterns.length ? findings.filter((f) => !ignorePatterns.some((p) => (f.pattern || "").includes(p))) : findings;
    return {
      findings: filteredFindings,
      summary: `${anomalies.length} service(s) with anomalies`,
      newMemory: this._capturedMemory || null,
      usage: usageAgg.totalTokens > 0 ? usageAgg : null,
    };
  },

  async execute(actions, agentClient) {
    // Auto-execution disabled for safety — always requires human approval
    return [];
  },

  async report({ collected, llmResult, run, row, config }) {
    const findings = llmResult.findings || [];
    for (const f of findings) {
      const { finding, isNew } = await upsertFinding({ models, run, finding: f, config });
      if (!isNew) continue; // Dedup match — skip actions/notifications
      // Create a pending restart action if service restart is recommended
      if (f.suggestedFix === "systemctl.restart" && f.source) {
        await models.SkillAction.create({
          skillRunId: run.id, findingId: finding.id,
          actionType: "systemctl.restart",
          target: f.source,
          parameters: JSON.stringify({ service: f.source }),
          status: "pending",
        });
      }
      if (f.severity === "critical" || f.severity === "warning") {
        await models.Notification.create({
          skillRunId: run.id, severity: f.severity,
          title: `[${f.source || "service"}] ${f.severity === "critical" ? "Anomaly detected" : "Warning"}`,
          message: f.message || "",
        });
      }
    }
    // Record heartbeat even without anomalies
    const total = (collected.serviceStatus?.services || []).length;
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${total} service(s) checked, all healthy`,
    });
  },
};
