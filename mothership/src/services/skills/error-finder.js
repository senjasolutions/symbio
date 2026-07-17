/**
 * Error Finder skill — scans system and application logs for errors, classifies
 * severity, and automatically fixes simple issues like restarting a stuck service.
 */

import { collectSkillData } from "../agent-client.js";
import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "error-finder";

const SYSTEM_PROMPT = `You are an error analysis AI for a Linux server. Scan the log entries below.

For each error/warning/fatal entry:
1. Classify SEVERITY: "info" | "warning" | "critical"
2. Identify the SOURCE: which service or component
3. Determine the PROBABLE CAUSE
4. Provide a "pattern" key for deduplication (e.g. source + error type, like "nginx.connect" or "php-fpm.OOM")
5. Suggest a FIX only if SIMPLE and SAFE (restart service, rotate logs, clear tmp)
6. For complex issues: just report, do not suggest a fix

Use the "memory" field to record recurring error patterns the operator should know about.

Respond ONLY with valid JSON:
{
  "findings": [{ "severity": "warning", "source": "nginx", "message": "connect() failed", "probableCause": "PHP-FPM not running", "pattern": "nginx.connect", "suggestedFix": "systemctl restart php8.3-fpm", "isSimpleFix": true, "fixConfidence": "high" }],
  "summary": "Found 1 warning, 0 critical errors",
  "memory": "Optional note about recurring patterns"
}`;

const DEFAULT_LOG_SOURCES = ["syslog", "auth", "kern", "daemon"];

export default {
  id: SKILL_KEY,

  async collect(agentClient, config) {
    const sources = Array.isArray(config.logSources) ? config.logSources : DEFAULT_LOG_SOURCES;
    return agentClient.collectSkillData(["logs"], {
      logSources: sources,
      logLines: config.maxLogLines || 200,
    });
  },

  async filter(collected, config) {
    if (!collected.logs) return false;
    const keywords = /error|fail|fatal|critical|oops|panic|segfault|OOM|killed|timeout/i;
    const ignorePatterns = Array.isArray(config.ignorePatterns) ? config.ignorePatterns.map((p) => new RegExp(p, "i")) : [];
    for (const lines of Object.values(collected.logs)) {
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        if (!keywords.test(line)) continue;
        if (ignorePatterns.some((re) => re.test(line))) continue;
        return true;
      }
    }
    return false;
  },

  async analyze(collected, llmConfig, config, memory) {
    const logText = Object.entries(collected.logs || {})
      .map(([source, lines]) => `--- ${source} ---\n${(lines || []).join("\n")}`)
      .join("\n\n");
    if (!logText.trim()) return { findings: [], summary: "No log data available." };

    const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "");

    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent: logText, maxTokens: 2048,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { findings: [], summary: `LLM error: ${result.error}` };
    try {
      const parsed = JSON.parse(result.content);
      let findings = Array.isArray(parsed.findings) ? parsed.findings : [];
      // Filter out ignored patterns
      const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
      if (ignorePatterns.length) {
        findings = findings.filter((f) => !ignorePatterns.some((p) => f.pattern?.includes(p)));
      }
      return {
        findings,
        summary: parsed.summary || "No analysis summary.",
        newMemory: parsed.memory || null,
        usage: result.usage,
      };
    } catch {
      return { findings: [], summary: "Failed to parse LLM response.", usage: result.usage };
    }
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
      // Create a pending action for any finding with a suggested fix
      if (f.suggestedFix && f.isSimpleFix) {
        const parts = f.suggestedFix.split(/\s+/);
        if (parts[0] === "systemctl" && parts[1] === "restart") {
          await models.SkillAction.create({
            skillRunId: run.id, findingId: finding.id,
            actionType: "systemctl.restart", target: parts[2] || "",
            parameters: JSON.stringify({ service: parts[2] || "" }),
            status: "pending",
          });
        }
      }
      await models.Notification.create({
        skillRunId: run.id, severity: f.severity || "info",
        title: `[${f.source || "unknown"}] ${(f.message || "").slice(0, 150)}`,
        message: f.probableCause || "",
      });
    }
    await run.update({
      status: findings.length ? "completed" : "completed",
      finishedAt: new Date(), summary: llmResult.summary || `${findings.length} finding(s)`,
    });
  },
};
