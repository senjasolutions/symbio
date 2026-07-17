/**
 * Optimizer skill — scans server configuration, resource usage, and service
 * settings to find optimization opportunities. Never auto-executes.
 * All suggestions require explicit human approval.
 */

import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "optimizer";

const SYSTEM_PROMPT = `You are a Linux server optimization expert. Based on the server's current configuration and resource usage below, identify optimizations that could improve performance, security, or stability.

For each optimization, explain:
- WHAT to change (specific config file, parameter, or setting)
- WHY it helps (performance, security, stability)
- RISK level (low, medium, high)
- COMMANDS needed to apply the change
- PATTERN: provide a unique deduplication key (e.g. category + title slug like "kernel.tcp-bbr")

RULES:
- NEVER suggest destructive actions (format, fdisk, rm -rf, etc.)
- NEVER suggest package removal
- Prioritize changes with clear measurable benefit
- If the server is already well-configured, say so

Record important observations in the "memory" field for future runs.

Respond ONLY with valid JSON:
{
  "optimizations": [
    {
      "category": "kernel",
      "title": "Enable TCP BBR congestion control",
      "description": "...",
      "pattern": "kernel.tcp-bbr",
      "riskLevel": "low",
      "commands": ["sysctl -w net.core.default_qdisc=fq", "sysctl -w net.ipv4.tcp_congestion_control=bbr"],
      "estimatedBenefit": "30% throughput improvement"
    }
  ],
  "summary": "Found 3 potential optimizations",
  "memory": "Optional note for future runs"
}`;

export default {
  id: SKILL_KEY,

  async collect(agentClient) {
    const data = await agentClient.collectSkillData(["server-info", "processes", "packages", "disk", "memory"]);
    return {
      info: data.serverInfo || {},
      processes: data.processes || {},
      packages: data.packages || {},
      disk: data.disk || {},
      memory: data.memory || {},
    };
  },

  async filter() {
    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    const info = collected.info || {};
    const cpus = info.cpu?.cores || info.cpu?.logicalCores || "?";
    const packages = collected.packages?.installed || [];
    const disk = collected.disk?.disks || [];

    const cpuCores = info.cpu?.cores || info.cpu?.logicalCores || "?";
    const ramTotal = collected.memory?.MemTotal || collected.memory?.total || "?";
    const osInfo = `${info.os?.name || ""} ${info.os?.version || ""}`.trim() || "Linux";

    const dataText = [
      `OS: ${osInfo}`,
      `Kernel: ${info.kernel || "?"}`,
      `CPU: ${cpuCores} logical cores, ${info.cpu?.model || "?"}`,
      `RAM: ${ramTotal}`,
      `Uptime: ${info.uptime || "?"}`,
      `Disks: ${JSON.stringify(disk)}`,
      `Installed packages: ${packages.slice(0, 30).map((p) => p.name).join(", ")}`,
    ].join("\n");

    const categories = Array.isArray(config?.categories) ? config.categories : [];
    const categoryFilter = categories.length ? `Only suggest optimizations for these categories: ${categories.join(", ")}.` : "";
    const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "") + "\n\n" + categoryFilter;

    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent: dataText, maxTokens: 2048,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { findings: [], summary: `LLM error: ${result.error}`, optimizations: [] };
    try {
      const parsed = JSON.parse(result.content);
      const opts = Array.isArray(parsed.optimizations) ? parsed.optimizations : [];
      const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
      const filteredOpts = ignorePatterns.length ? opts.filter((o) => !ignorePatterns.some((p) => (o.pattern || "").includes(p) || (o.title || "").includes(p))) : opts;
      return {
        findings: filteredOpts.map((o) => ({
          severity: "info", source: "optimizer",
          message: `${o.title} — ${o.description?.slice(0, 120) || ""}`,
          probableCause: `Risk: ${o.riskLevel || "?"} | Category: ${o.category || "?"}`,
          pattern: o.pattern || `${o.category || "system"}.${(o.title || "").toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
          suggestedFix: "config.change",
        })),
        summary: parsed.summary || `${filteredOpts.length} optimization(s) found`,
        optimizations: filteredOpts,
        newMemory: parsed.memory || null,
        usage: result.usage,
      };
    } catch {
      return { findings: [], summary: "Failed to parse LLM response.", optimizations: [], usage: result.usage };
    }
  },

  async execute(actions, agentClient) {
    const results = [];
    for (const action of actions) {
      if (action.optimization?.commands?.length) {
        const result = await agentClient.executeSkillActions(
          action.optimization.commands.map((cmd) => {
            const parts = cmd.split(/\s+/);
            return { action: "sysctl.configure", params: { command: cmd } };
          }),
        );
        results.push({ action: "config.change", result });
      }
    }
    return results;
  },

  async report({ collected, llmResult, run, row, config }) {
    const opts = llmResult.optimizations || [];
    for (const o of opts) {
      const findingData = {
        message: o.title || "Optimization suggestion",
        probableCause: o.description || "",
        severity: "info",
        source: "optimizer",
        pattern: o.pattern || `${o.category || "system"}.${(o.title || "").toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
        isSimpleFix: false,
        suggestedFix: JSON.stringify({
          actionType: "config.change",
          commands: o.commands || [],
          configFile: o.configFile || "",
          changes: o.changes || "",
        }),
      };
      const { finding, isNew } = await upsertFinding({ models, run, finding: findingData, config });
      if (!isNew) continue; // Dedup match — skip actions/notifications
      await models.SkillAction.create({
        skillRunId: run.id, findingId: finding.id,
        actionType: "config.change", target: o.category || "system",
        parameters: JSON.stringify({
          title: o.title, description: o.description,
          riskLevel: o.riskLevel, commands: o.commands || [],
          configFile: o.configFile, changes: o.changes,
          estimatedBenefit: o.estimatedBenefit,
        }),
        status: "pending",
      });
      await models.Notification.create({
        skillRunId: run.id, severity: "info",
        title: `[Optimizer] ${o.title || "Optimization"}`,
        message: `${o.description || ""} Risk: ${o.riskLevel || "?"}`,
      });
    }
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${opts.length} optimization(s) found`,
    });
  },
};
