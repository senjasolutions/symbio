/**
 * Storage Maid skill — monitors disk usage, identifies space hogs, and performs
 * safe cleanup actions. Respects user config for intensity, exclusions, thresholds.
 */

import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { executeWithProof } from "./proof.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "storage-maid";

const BASE_SYSTEM_PROMPT = `You are a storage management advisor for a Linux server. Given the current disk usage data, identify safe cleanup actions.

RULES:
- NEVER suggest deleting files from /etc, /usr, /bin, /sbin, /lib, /boot
- NEVER suggest removing packages (that is for Package Updater)
- Safe: truncate log files >100MB, clean apt cache, autoremove unneeded deps, vacuum journalctl

Keep track of patterns you notice — recurring large files, rapid disk fills, etc. Use the "memory" field to record important observations for future runs.

Respond ONLY with valid JSON:
{
  "findings": [{ "severity": "info", "source": "storage", "message": "...", "probableCause": "...", "pattern": "apt.cache", "suggestedFix": "apt.clean", "isSimpleFix": true }],
  "safeCleanupActions": [{ "action": "apt.clean", "description": "Clean apt cache", "estimatedFreedMb": 200 }],
  "needsConfirmation": [{ "action": "file.truncate", "description": "Truncate /var/log/syslog >100MB", "target": "/var/log/syslog", "estimatedFreedMb": 500 }],
  "diskUsagePercent": "85",
  "totalEstimatedFreedMb": 1200,
  "summary": "...",
  "memory": "Optional note for future runs"
}`;

// Additional prompt instructions per depth level — appended to the base prompt.
const DEPTH_HINTS = {
  light: "Focus only on log files and user home cache. Recommend truncating oversized logs and cleaning journalctl.",
  standard: "Scan logs, apt cache, and temporary files. Recommend truncating logs, cleaning apt cache, autoremove, and vacuuming journalctl.",
  deep: "Full system sweep — logs, apt cache, temp files, Docker unused images/containers, spool files. Be thorough but never touch system config files.",
};

export default {
  id: SKILL_KEY,

  async collect(agentClient, config) {
    const intensity = config.intensity || "safe";
    const depth = config.cleanDepth || "light";
    const excludeDirs = Array.isArray(config.excludeDirs) ? config.excludeDirs : [];
    // Depth determines which directories to scan and file size thresholds
    const depthDirs = {
      light: ["/var/log", "/home"],
      standard: ["/var/log", "/var/cache/apt", "/tmp"],
      deep: ["/var/log", "/var/cache/apt", "/tmp", "/var/lib/docker", "/var/spool", "/var/tmp"],
    };
    const depthMinMb = { light: 100, standard: 50, deep: 20 };
    const allDirs = depthDirs[depth] || depthDirs.light;
    const allowedDirs = allDirs.filter((d) => !excludeDirs.some((ex) => d.startsWith(ex)));
    return agentClient.collectSkillData(["disk"], {
      largeFilesMinMb: depthMinMb[depth],
      largeFilesDirs: allowedDirs.length ? allowedDirs : ["/var/log"],
    });
  },

  async filter() {
    return true;
  },

  async analyze(collected, llmConfig, config, memory) {
    const disk = collected.disk || {};
    const depth = config.cleanDepth || "light";
    const diskText = [
      `Disks: ${JSON.stringify(disk.disks || [])}`,
      `Journalctl: ${disk.journalctlSize || "unknown"}`,
      `Large files: ${JSON.stringify((disk.largeFiles || []).slice(0, 30))}`,
    ].join("\n");

    const depthHint = DEPTH_HINTS[depth] || DEPTH_HINTS.light;
    const systemPrompt = BASE_SYSTEM_PROMPT + "\n\n" + depthHint + (memory ? `\n\nMemory from past runs:\n${memory}` : "");

    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent: diskText, maxTokens: 1536,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { findings: [], summary: `LLM error: ${result.error}` };
    try {
      const parsed = JSON.parse(result.content);
      const allActions = [...(parsed.safeCleanupActions || []), ...(parsed.needsConfirmation || [])];
      const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
      const filteredActions = ignorePatterns.length ? allActions.filter((a) => !ignorePatterns.some((p) => (a.pattern || "").includes(p) || (a.description || "").includes(p))) : allActions;
      return {
        findings: filteredActions.map((a) => ({
          severity: "info", source: "storage",
          message: a.description || `Cleanup: ${a.action}`,
          probableCause: `Estimated free: ${a.estimatedFreedMb || "?"} MB`,
          pattern: a.pattern || `${a.action}.${a.target || "system"}`,
          suggestedFix: a.action,
          isSimpleFix: !a.target,
        })),
        summary: parsed.summary || `${parsed.diskUsagePercent || collected.disk?.diskUsagePercent || "?"}% disk used`,
        diskUsagePercent: parsed.diskUsagePercent || collected.disk?.diskUsagePercent,
        estimatedFreedMb: parsed.totalEstimatedFreedMb || 0,
        newMemory: parsed.memory || null,
        usage: result.usage,
      };
    } catch {
      return { findings: [], summary: "Failed to parse LLM response.", usage: result.usage };
    }
  },

  async execute(actions, agentClient) {
    const autoSafe = ["apt.clean", "apt.autoremove", "journalctl.vacuum"];
    const mapped = actions.filter((a) => a.suggestedFix && autoSafe.includes(a.suggestedFix)).map((a) => {
      const map = {
        "apt.clean": { action: "apt.clean", params: {} },
        "apt.autoremove": { action: "apt.autoremove", params: {} },
        "journalctl.vacuum": { action: "journalctl.vacuum", params: {} },
      };
      return map[a.suggestedFix] || null;
    }).filter(Boolean);
    if (!mapped.length) return [];
    return (await agentClient.executeSkillActions(mapped)).results || [];
  },

  async report({ collected, llmResult, run, row, config }) {
    const findings = llmResult.findings || [];
    const autoSafe = ["apt.clean", "apt.autoremove", "journalctl.vacuum"];
    for (const f of findings) {
      const { finding, isNew } = await upsertFinding({ models, run, finding: f, config });
      if (!isNew) continue; // Dedup match — skip actions/notifications
      if (f.suggestedFix) {
        const isAuto = autoSafe.includes(f.suggestedFix);
        const params = {};
        if (f.suggestedFix === "file.truncate") params.target = (f.message || "").replace(/^Truncate /, "");
        if (f.suggestedFix === "file.remove") params.target = f.message?.match(/\/\S+/)?.[0] || "";
        let result = null;
        let executedAt = null;
        if (isAuto) {
          try {
            const proof = await executeWithProof({ action: f.suggestedFix, params });
            result = JSON.stringify(proof);
            executedAt = new Date();
          } catch (error) {
            result = JSON.stringify({ error: error.message });
          }
        }
        await models.SkillAction.create({
          skillRunId: run.id, findingId: finding.id,
          actionType: f.suggestedFix, target: params.target || "",
          parameters: JSON.stringify(params),
          status: isAuto ? "executed" : "pending",
          executedAt,
          result,
        });
      }
    }
    if (llmResult.estimatedFreedMb > 0) {
      await models.Notification.create({
        skillRunId: run.id, severity: "info",
        title: `Storage cleanup: ~${llmResult.estimatedFreedMb}MB can be freed`,
        message: llmResult.summary || "",
      });
    }
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${findings.length} storage finding(s)`,
    });
  },
};
