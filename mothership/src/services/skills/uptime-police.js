/**
 * Uptime Police — service reliability monitoring with self-healing.
 *
 * DETECTION: systemd services AND Docker containers, with 3-consecutive-failure
 * threshold. Collects process resource usage, memory pressure, and recent log
 * errors alongside service status for rich degradation analysis.
 *
 * ROOT CAUSE: all service states (healthy + anomalous) are sent to the LLM so it
 * can identify dependency chains. The LLM sets restartPriority (1=root cause,
 * first) so dependent services restart after their dependencies are healthy.
 *
 * SELF-HEALING: low-risk auto-restarts include health-gated roll semantics —
 * after each restart the system polls systemctl/docker until the service is
 * healthy (or 30s timeout), then proceeds to the next. Docker containers use
 * docker.restart; systemd services use systemctl.restart.
 *
 * SAFETY: low-risk + safe → auto-heal with proof. Medium/high → Execution
 * Request for human approval. Critical → always notifies.
 */

import { callSkillAI } from "../llm.service.js";
import { executeWithProof } from "./proof.js";
import { executeSkillActions, collectSkillData } from "../agent-client.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "uptime-police";

/** In-memory state: tracks last N checks per service for anomaly detection. */
const checkHistory = new Map();
const ANOMALY_THRESHOLD = 3;

/**
 * Tracks restart attempts per service to avoid infinite retry loops.
 * If a service keeps crashing after MAX_RESTART_ATTEMPTS, the system gives up
 * and recommends manual investigation. Counter resets after an hour of stability.
 */
const restartCounters = new Map();
const DEFAULT_MAX_RESTART = 3;
const COUNTER_RESET_MS = 60 * 60 * 1000; // 1 hour

const getRestartState = (name, config) => {
  const maxAttempts = parseInt(config?.maxRestartAttempts) || DEFAULT_MAX_RESTART;
  const entry = restartCounters.get(name);
  if (!entry) return { remaining: maxAttempts, exhausted: false };
  // Decay: if the service has been stable for long enough, reset the counter
  if (Date.now() - entry.lastAttempt > COUNTER_RESET_MS) {
    restartCounters.delete(name);
    return { remaining: maxAttempts, exhausted: false };
  }
  const remaining = maxAttempts - entry.count;
  return { remaining: Math.max(0, remaining), exhausted: remaining <= 0, attempts: entry.count };
};

const recordRestartAttempt = (name, success) => {
  const entry = restartCounters.get(name) || { count: 0, lastAttempt: 0 };
  entry.count = success ? 0 : (entry.count + 1);
  entry.lastAttempt = Date.now();
  if (success) entry.count = 0;
  restartCounters.set(name, entry);
};

/**
 * Cooldown tracking — avoids redundant LLM calls when anomaly state hasn't changed.
 * Only calls the LLM when: (1) a new service became anomalous, (2) a service recovered,
 * or (3) last call was more than COOLDOWN_MS ago (periodic re-check).
 */
let lastAnalyzedState = { timestamp: 0, anomalyKeys: [] };
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between LLM calls for identical state

const MONITORED_SERVICES = ["nginx", "apache2", "mysql", "postgresql", "redis-server", "docker", "pm2"];

const SYSTEM_PROMPT = `You are a Linux service reliability monitor. Examine the evidence below and determine the health of each service.

For each ANOMALOUS service (down, slow, erroring, resource-starved), return a finding with:
- severity: "info" | "warning" | "critical"
- source: service/container name
- message: what happened
- pattern: source name for deduplication
- likelyCause: brief root cause
- recommendedAction: "restart" | "wait" | "manual-investigation"
- riskLevel: "low" | "medium" | "high"
  - low: auto-heal — safe to restart automatically
  - medium: human approval required
  - high: human must investigate
- safeToRestart: true if restarting fixes the issue
- summary: one-line summary
- restartPriority: 1 = root cause (restart first), 2 = dependent, 3 = independent

RESTART GIVE-UP:
Each anomalous service has a "restart_attempts" count shown in evidence.
If a service has exhausted its max attempts (default 3), do NOT recommend restart.
Recommend "manual-investigation" instead — the service has been repeatedly
auto-restarted and keeps crashing.

ROOT CAUSE & ORDERING:
When multiple services are failing together, some may be dependent on others:
- nginx, apache2, httpd typically depend on php-fpm, php, mysql, postgresql
- php-fpm, php depend on mysql, postgresql, redis
- mysql, postgresql are usually standalone
- Restarting the root cause first is more effective.

Set restartPriority for each finding that needs restart:
- 1 = root cause — this MUST be restarted first (others depend on it)
- 2 = depends on root cause — restart after priority 1
- 3 = independent — restart order doesn't matter

Self-healing restarts execute in priority order with health checks between them.
Low-risk + safe restarts are auto-executed. Medium-risk go to human approval.

Respond ONLY with valid JSON:
{
  "findings": [{
    "severity": "warning",
    "source": "nginx",
    "message": "nginx is down — connect() failed to php-fpm upstream",
    "pattern": "nginx",
    "likelyCause": "php-fpm is down, nginx cannot connect to upstream",
    "recommendedAction": "restart",
    "riskLevel": "low",
    "safeToRestart": true,
    "restartPriority": 2,
    "summary": "nginx will recover once php-fpm is restarted",
    "memory": ""
  }, {
    "severity": "critical",
    "source": "php-fpm",
    "message": "php-fpm is down — process not found, systemctl inactive",
    "pattern": "php-fpm",
    "likelyCause": "PHP-FPM process crashed or OOM-killed",
    "recommendedAction": "restart",
    "riskLevel": "medium",
    "safeToRestart": true,
    "restartPriority": 1,
    "summary": "php-fpm is the root cause — restart this first",
    "memory": ""
  }],
  "summary": "2 services have anomalies",
  "memory": ""
}`;

export default {
  id: SKILL_KEY,

  async collect(agentClient, config) {
    const services = Array.isArray(config.monitoredServices) ? config.monitoredServices : MONITORED_SERVICES;
    const types = ["service-status", "processes", "memory"];
    if (config.checkServiceLogs !== false) types.push("logs");
    // Monitor Docker containers when Docker collection is available
    if (config.monitorContainers !== false) types.push("docker");
    return agentClient.collectSkillData(types, {
      services,
      logSources: ["syslog"],
      logLines: config.maxLogLines || 50,
    });
  },

  async filter(collected) {
    // Merge systemd services and Docker containers into one monitoring list
    const allServices = [];

    for (const svc of collected.serviceStatus?.services || []) {
      allServices.push({ ...svc, isContainer: false });
    }
    for (const c of collected.docker?.containers || []) {
      allServices.push({
        name: c.name,
        isActive: c.running ? "active" : c.restarting ? "degraded" : "inactive",
        processDetected: c.running,
        isContainer: true,
        restartCount: c.restarting ? 1 : 0,
      });
    }

    const anomalies = [];
    for (const svc of allServices) {
      const key = `${svc.isContainer ? "c:" : "s:"}${svc.name}`;
      if (!checkHistory.has(key)) checkHistory.set(key, []);
      const history = checkHistory.get(key);
      history.push(svc.isActive !== "active");
      if (history.length > ANOMALY_THRESHOLD) history.shift();
      const failures = history.filter(Boolean).length;
      if (failures >= ANOMALY_THRESHOLD) anomalies.push(key);
    }
    if (!anomalies.length) return false;

    // System-wide unresponsiveness guard: if EVERY monitored service is flagged as
    // unknown/inactive simultaneously, it's not a per-service problem. The host may be
    // down, systemd unreachable, or the agent disconnected. Skip LLM entirely — no token
    // waste on analyzing "all 7 services are unknown" hundreds of times.
    if (anomalies.length === allServices.length && allServices.length > 2) {
      return false;
    }

    this._anomalyKeys = anomalies;
    this._allServices = allServices;
    // Prune stale entries
    const activeKeys = new Set(allServices.map((s) => `${s.isContainer ? "c:" : "s:"}${s.name}`));
    for (const key of checkHistory.keys()) {
      if (!activeKeys.has(key)) checkHistory.delete(key);
    }
    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    this._capturedMemory = null;
    const anomalyKeys = this._anomalyKeys || [];
    const allServices = this._allServices || [];
    if (!anomalyKeys.length) return { findings: [], summary: "All services healthy." };

    // LLM cooldown: if the same set of services is anomalous as the last analysis,
    // and the cooldown hasn't elapsed, skip the redundant LLM call.
    // The dedup in report() already handles repeated findings, but this prevents
    // the expensive (and pointless) LLM call with identical evidence.
    const sameAnomalies = anomalyKeys.length === lastAnalyzedState.anomalyKeys.length
      && anomalyKeys.every((k) => lastAnalyzedState.anomalyKeys.includes(k));
    const cooldownElapsed = Date.now() - lastAnalyzedState.timestamp > COOLDOWN_MS;
    if (sameAnomalies && !cooldownElapsed) {
      return { findings: [], summary: `Anomaly state unchanged — skipped (${anomalyKeys.length} service(s) still anomalous)` };
    }

    // Build full service state summary (for dependency reasoning)
    const logData = collected.logs?.syslog || [];
    const procData = collected.processes?.processes || [];
    const memData = collected.memory || {};
    const dockerData = collected.docker?.containers || [];

    // Section 1: ALL service states (healthy + anomalous)
    const stateSummary = allServices.map((svc) => {
      const tag = svc.isContainer ? "[container]" : "[systemd]";
      return `  ${svc.name} ${tag}: ${svc.isActive}`;
    });
    const evidenceBlocks = [`--- All Service States ---\n${stateSummary.join("\n")}`];

    // Section 2: Detailed evidence per anomalous service
    for (const key of anomalyKeys.slice(0, 4)) {
      const isContainer = key.startsWith("c:");
      const name = key.replace(/^[cs]:/, "");
      const svc = allServices.find((s) => s.name === name) || {};
      const restartState = getRestartState(name, config);
      const lines = [
        `\n--- ${name}${isContainer ? " [container]" : " [systemd]"} ---`,
        `status: ${svc.isActive || "unknown"}`,
        `restart_attempts: ${restartState.exhausted ? "MAXED OUT (giving up)" : restartState.remaining > 0 ? `${restartState.attempts || 0} used, ${restartState.remaining} remaining` : "0 used"}`,
      ];

      if (isContainer) {
        // Docker container evidence
        const dc = dockerData.find((c) => c.name === name);
        if (dc) {
          lines.push(`docker status: ${dc.status}`);
          lines.push(`restarting: ${dc.restarting}`);
        }
      } else {
        lines.push(`process detected: ${svc.processDetected}`);
        const match = procData.find((p) => p.name === name || (p.command || "").includes(name));
        if (match) {
          lines.push(`CPU: ${match.cpuPercent || "?"}%, memory: ${match.memBytes || "?"} bytes`);
        } else {
          lines.push("CPU: N/A");
        }
      }

      // Log context
      const relevant = logData.filter((l) => l.toLowerCase().includes(name.toLowerCase())).slice(0, 4);
      if (relevant.length) {
        lines.push("log entries:");
        relevant.forEach((l) => lines.push(`  ${l.slice(0, 200)}`));
      }

      evidenceBlocks.push(lines.join("\n"));
    }

    // Section 3: Memory pressure
    if (memData?.MemTotal) {
      evidenceBlocks.push(
        `\n--- System Memory ---\ntotal=${memData.MemTotal}, available=${memData.MemAvailable || "?"}, swap=${memData.SwapTotal || "?"}`
      );
    }

    const dataContent = evidenceBlocks.join("\n");
    const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "");

    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent, maxTokens: 2560,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });

    // Update cooldown tracker — LLM was called, record state regardless of outcome
    lastAnalyzedState = { timestamp: Date.now(), anomalyKeys };

    if (result.error) return { findings: [], summary: `LLM error: ${result.error}` };

    try {
      const parsed = JSON.parse(result.content);
      let findings = Array.isArray(parsed.findings) ? parsed.findings : [];

      // Map LLM fields to finding structure, enriched with isContainer and restartPriority
      findings = findings.map((f) => {
        const src = f.source || f.service || "";
        const svc = allServices.find((s) => s.name === src);
        const isContainer = svc?.isContainer === true;
        return {
          severity: f.severity || "info",
          source: src,
          message: f.message || f.summary || `${src} anomaly`,
          probableCause: f.likelyCause || "",
          pattern: f.pattern || src,
          isContainer,
          suggestedFix: f.recommendedAction === "restart" ? (isContainer ? "docker.restart" : "systemctl.restart") : "",
          isSimpleFix: f.riskLevel === "low" && f.safeToRestart && f.recommendedAction === "restart",
          riskLevel: f.riskLevel || "medium",
          safeToRestart: f.safeToRestart !== false,
          recommendedAction: f.recommendedAction || "manual-investigation",
          restartPriority: typeof f.restartPriority === "number" ? f.restartPriority : 99,
          summary: f.summary || "",
        };
      });

      const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
      if (ignorePatterns.length) {
        findings = findings.filter((f) => !ignorePatterns.some((p) => (f.pattern || "").includes(p)));
      }

      this._capturedMemory = parsed.memory || null;

      return {
        findings,
        summary: parsed.summary || `${findings.length} service(s) with anomaly`,
        newMemory: this._capturedMemory || null,
        usage: result.usage,
      };
    } catch {
      return { findings: [], summary: "Failed to parse LLM response.", usage: result.usage };
    }
  },

  async execute() {
    return [];
  },

  /**
   * Polls the agent until a restarted service becomes healthy or timeout.
   * For containers: checks docker.containers[].running.
   * For systemd: checks service-status[].isActive === "active".
   */
  async waitForHealthy(name, isContainer, timeoutMs = 30000) {
    const pollMs = 2000;
    const maxPolls = Math.floor(timeoutMs / pollMs);
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        if (isContainer) {
          const data = await collectSkillData(["docker"], {});
          const c = data.docker?.containers?.find((c) => c.name === name);
          if (c?.running) return { healthy: true, attempts: i + 1 };
        } else {
          const data = await collectSkillData(["service-status"], { services: [name] });
          const svc = data.serviceStatus?.services?.[0];
          if (svc?.isActive === "active") return { healthy: true, attempts: i + 1 };
        }
      } catch {}
    }
    return { healthy: false, attempts: maxPolls };
  },

  async report({ collected, llmResult, run, row, config }) {
    const findings = llmResult.findings || [];
    if (!findings.length) {
      await run.update({ status: "completed", finishedAt: new Date(), summary: "All services healthy." });
      return;
    }

    // Sort by restartPriority so root cause services restart first
    const sorted = [...findings].sort(
      (a, b) => (a.restartPriority || 99) - (b.restartPriority || 99)
    );

    for (const f of sorted) {
      const { finding, isNew } = await upsertFinding({ models, run, finding: f, config });
      if (!isNew) continue;

      const canAutoExecute = f.recommendedAction === "restart" && f.riskLevel === "low" && f.safeToRestart && f.source;
      // Check if max restart attempts have been exhausted — give up if so
      const restartState = getRestartState(f.source, config);
      const shouldAutoExecute = canAutoExecute && !restartState.exhausted;

      const actionType = f.isContainer ? "docker.restart" : "systemctl.restart";
      const params = isContainerRestart(f) ? { container: f.source } : { service: f.source };

      let result = null;
      let executedAt = null;
      let healthOk = false;

      if (shouldAutoExecute) {
        try {
          const proof = await executeWithProof({ action: actionType, params });
          result = JSON.stringify(proof);
          executedAt = new Date();

          // Health-gated rolling: wait for this service before proceeding
          if (sorted.length > 1) {
            const health = await this.waitForHealthy(f.source, f.isContainer, 30000);
            healthOk = health.healthy;
            if (!health.healthy) {
              result = JSON.stringify({
                ...JSON.parse(result || "{}"),
                healthCheck: "Service did not become healthy within 30s — manual investigation recommended.",
              });
            }
          } else {
            healthOk = true;
          }

          // Record restart attempt — reset counter on success, increment on failure
          recordRestartAttempt(f.source, healthOk);
        } catch (error) {
          result = JSON.stringify({ error: error.message });
          recordRestartAttempt(f.source, false);
        }
      }

      if ((actionType === "systemctl.restart" || actionType === "docker.restart") && f.source) {
        await models.SkillAction.create({
          skillRunId: run.id, findingId: finding.id,
          actionType,
          target: f.source,
          parameters: JSON.stringify({
            ...params,
            riskLevel: f.riskLevel,
            recommendedAction: f.recommendedAction,
            likelyCause: f.probableCause || "",
            restartPriority: f.restartPriority,
            isContainer: f.isContainer,
            restartAttempts: restartState.attempts || 0,
          }),
          status: shouldAutoExecute ? "executed" : "pending",
          executedAt,
          result,
        });
      }

      const needsNotification = f.severity === "critical"
        || (f.severity === "warning" && !shouldAutoExecute);
      if (needsNotification) {
        await models.Notification.create({
          skillRunId: run.id, severity: f.severity,
          title: f.severity === "critical"
            ? `[${f.source}] Critical — ${f.summary || f.message || ""}`
            : `[${f.source}] Warning — ${f.summary || f.message || ""}`,
          message: f.probableCause || "",
        });
      }
    }

    const totalServices = (collected.serviceStatus?.services || []).length
      + (collected.docker?.containers?.length || 0);
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${totalServices} service(s) monitored`,
    });
  },
};

function isContainerRestart(finding) {
  return finding.isContainer === true
    || finding.source?.startsWith("c:")
    || finding.suggestedFix === "docker.restart";
}
