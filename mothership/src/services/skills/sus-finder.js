/**
 * SUS Finder skill — scans for suspicious activity: brute force attacks, unusual
 * network connections, malicious processes, unknown crontabs, and signs of compromise.
 * Reporting only — never auto-executes. User can acknowledge or ignore patterns.
 */

import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "sus-finder";

const SYSTEM_PROMPT = `You are a Linux security analyst. Examine the server data below for suspicious or malicious activity.

For each finding, provide a severity, source, clear message, probable cause, and a "pattern" key for deduplication (IP address, process name, port number, or other unique identifier).

Suspicious patterns to watch for:
- Brute force attacks (repeated failed SSH/auth logins from same IP)
- Unusual network connections (non-standard ports, connections to known-bad IP ranges)
- Malicious processes (miners like xmrig, cryptonight, reverse shells, /tmp/.* execution)
- Suspicious listening ports (common malware ports: 4444, 1337, 31337, 6666-6669)
- Unknown or unauthorized crontab entries
- Sudden spikes in failed logins
- Root/sudo access from unusual IPs
- Processes running from /tmp, /dev/shm, or other temp directories

RULES:
- Be conservative: only flag genuinely suspicious patterns, not normal system activity
- If nothing suspicious is found, return empty findings
- CRITICAL severity only for clear signs of compromise (active reverse shell, known malware process, successful unauthorized root access)

Respond ONLY with valid JSON:
{
  "findings": [
    {
      "severity": "warning",
      "source": "auth",
      "message": "Brute force: 47 failed SSH logins from 192.168.1.100 in last 5 minutes",
      "pattern": "192.168.1.100",
      "probableCause": "Automated SSH scanner attempting dictionary attack"
    }
  ],
  "summary": "Found 1 suspicious activity",
  "memory": "Optional note about observed patterns for future runs"
}`;

export default {
  id: SKILL_KEY,

  async collect(agentClient, config) {
    const types = [];
    if (config.checkAuthLog !== false) types.push("logs");
    if (config.checkProcesses !== false) types.push("processes");
    if (config.checkPorts !== false) types.push("ports");
    if (config.checkFailedLogins !== false) types.push("failed-logins");
    if (config.checkCrontabs !== false) types.push("crontabs");
    types.push("recent-logins", "network");

    const data = await agentClient.collectSkillData(types, {
      logSources: ["auth"],
      logLines: config.maxAuthLogLines || 300,
      maxFailedLogins: config.maxFailedLogins || 50,
    });
    return data;
  },

  async filter(collected, config) {
    // Skip LLM if there's nothing to check per config
    if (config.checkAuthLog === false && config.checkProcesses === false &&
        config.checkPorts === false && config.checkFailedLogins === false &&
        config.checkCrontabs === false) return false;
    // Skip LLM if there's no collected data to analyze
    const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
    const hasData = Object.values(collected).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return !!v;
    });
    if (!hasData) return false;
    // If ignore patterns cover all known patterns, skip
    if (ignorePatterns.length) {
      const allPatternsAlreadyIgnored = collected.failedLogins?.every?.((l) =>
        ignorePatterns.some((p) => l.includes(p))
      ) && collected.logs?.auth?.every?.((l) =>
        ignorePatterns.some((p) => l.includes(p))
      );
      if (allPatternsAlreadyIgnored) return false;
    }
    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    const parts = [];

    if (collected.logs?.auth?.length) {
      parts.push("--- AUTH LOG (last entries) ---\n" + collected.logs.auth.join("\n"));
    }
    if (collected.failedLogins?.length) {
      parts.push("--- FAILED LOGINS (lastb) ---\n" + collected.failedLogins.join("\n"));
    }
    if (collected.recentLogins?.length) {
      parts.push("--- RECENT LOGINS (last) ---\n" + collected.recentLogins.join("\n"));
    }
    if (collected.processes?.processes?.length) {
      const procs = collected.processes.processes.slice(0, 80);
      parts.push("--- PROCESSES ---\n" + procs.map((p) => `${p.pid} ${p.user} ${(p.command || "").slice(0, 100)}`).join("\n"));
    }
    if (collected.ports?.ports?.length) {
      const ports = collected.ports.ports.filter((p) => p.localPort);
      parts.push("--- LISTENING PORTS ---\n" + ports.map((p) => `${p.localPort} ${p.protocol} ${p.processName || ""}`).join("\n"));
    }
    if (collected.network?.length) {
      parts.push("--- NETWORK CONNECTIONS (ss) ---\n" + collected.network.join("\n"));
    }
    if (collected.crontabs?.length) {
      parts.push("--- CRONTABS ---\n" + collected.crontabs.join("\n"));
    }

    const dataText = parts.join("\n\n");
    if (!dataText.trim()) return { findings: [], summary: "No data available." };

    const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
    const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "");

    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent: dataText, maxTokens: 2048,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { findings: [], summary: `LLM error: ${result.error}` };
    try {
      const parsed = JSON.parse(result.content);
      let findings = Array.isArray(parsed.findings) ? parsed.findings : [];
      // Filter out ignored patterns
      if (ignorePatterns.length) {
        findings = findings.filter((f) => !ignorePatterns.some((p) => f.pattern?.includes(p)));
      }
      return {
        findings,
        summary: parsed.summary || `${findings.length} suspicious activity found`,
        newMemory: parsed.memory || null,
        usage: result.usage,
      };
    } catch {
      return { findings: [], summary: "Failed to parse LLM response.", usage: result.usage };
    }
  },

  async execute() {
    return [];
  },

  async report({ llmResult, run, config }) {
    const findings = llmResult.findings || [];
    for (const f of findings) {
      const { finding, isNew } = await upsertFinding({ models, run, finding: f, config });
      if (!isNew) continue; // Dedup match — skip actions/notifications
      await models.SkillAction.create({
        skillRunId: run.id, findingId: finding.id,
        actionType: "security.alert", target: f.source || "",
        parameters: JSON.stringify({
          pattern: f.pattern || "",
          message: f.message,
          severity: f.severity,
        }),
        status: "pending",
      });
      if (f.severity === "critical") {
        await models.Notification.create({
          skillRunId: run.id, severity: "critical",
          title: `[SUS Finder] ${(f.message || "").slice(0, 120)}`,
          message: f.probableCause || "",
        });
      }
    }
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${findings.length} finding(s)`,
    });
  },
};
