/**
 * Error Finder skill — scans system and application logs for errors, classifies
 * severity, and automatically fixes simple issues like restarting a stuck service.
 *
 * Token optimization: content hash prevents re-processing identical logs,
 * only error-matching lines are sent to the LLM,
 * and open findings context helps the LLM reuse existing pattern keys.
 */

import crypto from "node:crypto";
import { collectSkillData } from "../agent-client.js";
import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding, getOpenFindingsContext } from "./helpers.js";

const SKILL_KEY = "error-finder";

/** Tracks the hash of last-processed logs to skip redundant LLM calls. */
let lastLogHash = null;

/** Keywords that indicate a log line needs analysis. Kept at module level so
 *  filter() and analyze() use the same pattern for consistent extraction. */
const ERROR_KEYWORDS = /error|fail|fatal|critical|oops|panic|segfault|OOM|killed|timeout/i;

const SYSTEM_PROMPT = `You are an error analysis AI for a Linux server. Scan the log entries below (only lines matching error keywords are shown).

For each error/warning/fatal entry:
1. Classify SEVERITY: "info" | "warning" | "critical"
2. Identify the SOURCE: which service or component
3. Determine the PROBABLE CAUSE
4. Provide a "pattern" key for deduplication (e.g. source + error type, like "nginx.connect" or "php-fpm.OOM")
5. Suggest a FIX only if SIMPLE and SAFE (restart service, rotate logs, clear tmp)
6. For complex issues: just report, do not suggest a fix

If no actual errors are found (e.g. only informational messages matched), return an empty findings array.

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

    // Content hash — skip if log content is identical to the last processed run.
    // Prevents redundant LLM calls when no new log data has been written.
    const logStr = JSON.stringify(collected.logs);
    const currentHash = crypto.createHash("md5").update(logStr).digest("hex");

    const ignorePatterns = Array.isArray(config.ignorePatterns) ? config.ignorePatterns.map((p) => new RegExp(p, "i")) : [];
    let hasMatch = false;
    for (const lines of Object.values(collected.logs)) {
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        if (!ERROR_KEYWORDS.test(line)) continue;
        if (ignorePatterns.some((re) => re.test(line))) continue;
        hasMatch = true;
        break;
      }
      if (hasMatch) break;
    }
    if (!hasMatch) return false;

    // Same log content as last run — no new errors to analyze
    if (currentHash === lastLogHash) return false;
    lastLogHash = currentHash;

    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    // Extract only lines matching error keywords — drastically reduces LLM input.
    const logParts = [];
    for (const [source, lines] of Object.entries(collected.logs || {})) {
      const matching = (lines || []).filter((line) => ERROR_KEYWORDS.test(line));
      if (matching.length) {
        logParts.push(`--- ${source} ---\n${matching.join("\n")}`);
      }
    }
    if (!logParts.length) return { findings: [], summary: "No log data available." };
    const logText = logParts.join("\n\n");

    // Inject open findings context so the LLM reuses existing pattern keys
    // instead of generating new ones for the same issues.
    const openCtx = await getOpenFindingsContext(models, SKILL_KEY);
    const dataContent = openCtx ? `${openCtx}\n\n${logText}` : logText;

    const trimmedMemory = memory ? memory.slice(-500) : "";
    const systemPrompt = SYSTEM_PROMPT + (trimmedMemory ? `\n\nMemory from past runs:\n${trimmedMemory}` : "");

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
