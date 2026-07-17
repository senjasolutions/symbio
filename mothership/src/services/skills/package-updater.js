/**
 * Package Updater skill — checks for available updates, prioritizes security
 * patches, and applies them safely. Only triggers LLM when updates exist.
 */

import { callSkillAI } from "../llm.service.js";
import { models } from "../../db/index.js";
import { upsertFinding } from "./helpers.js";

const SKILL_KEY = "package-updater";

const SYSTEM_PROMPT = `You are a package update advisor for a Linux server. Given the available package updates, prioritize them.

1. Security updates (identify by package names like openssl, libssl, libgnutls, etc.)
2. Bugfix updates
3. Feature updates

Use the "memory" field to record notable update patterns.

Respond ONLY with valid JSON:
{
  "securityUpdates": [{ "package": "nginx", "version": "1.26.4", "severity": "high", "pattern": "pkg.nginx" }],
  "regularUpdates": [{ "package": "htop", "version": "3.3.0", "pattern": "pkg.htop" }],
  "summary": "12 updates available, 6 are security-critical",
  "memory": "Optional note about update patterns"
}`;

export default {
  id: SKILL_KEY,

  async collect(agentClient) {
    const data = await agentClient.collectSkillData(["packages"]);
    const pkgs = data.packages || {};
    return {
      updates: pkgs.updates || [],
      installed: pkgs.installed || [],
      isLocked: pkgs.isLocked === true,
    };
  },

  async filter(collected, config) {
    if (collected.isLocked) return false;
    const updates = collected.updates || [];
    const ignored = Array.isArray(config?.ignoredPackages) ? config.ignoredPackages : [];
    return updates.some((u) => !ignored.includes(u.pkg));
  },

  async analyze(collected, llmConfig, config, memory) {
    const ignored = Array.isArray(config?.ignoredPackages) ? config.ignoredPackages : [];
    const pkgText = [
      `Available updates (${collected.updates.length}):`,
      ...(collected.updates || []).filter((u) => !ignored.includes(u.pkg)).map((u) => `  ${u.pkg}: ${u.newVersion}`),
    ].join("\n");
    if (!pkgText.trim()) return { findings: [], summary: "No updates available." };

    const systemPrompt = SYSTEM_PROMPT + (memory ? `\n\nMemory from past runs:\n${memory}` : "");
    const result = await callSkillAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      systemPrompt, dataContent: pkgText, maxTokens: 1536,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { findings: [], summary: `LLM error: ${result.error}` };
    try {
      const parsed = JSON.parse(result.content);
      const allUpdates = [...(parsed.securityUpdates || []), ...(parsed.regularUpdates || [])];
      const ignorePatterns = Array.isArray(config?.ignorePatterns) ? config.ignorePatterns : [];
      const filtered = ignorePatterns.length ? allUpdates.filter((u) => !ignorePatterns.some((p) => (u.pattern || "").includes(p) || u.package?.includes(p))) : allUpdates;
      return {
        findings: filtered.map((u) => ({
          severity: "info", source: "packages",
          message: `${u.package}: ${u.version || "update available"}`,
          probableCause: u.severity || "info",
          pattern: u.pattern || `pkg.${u.package}`,
          suggestedFix: "apt.upgrade",
        })),
        summary: parsed.summary || `${allUpdates.length} package(s) to update`,
        packages: allUpdates.map((u) => u.package).filter(Boolean),
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

  async report({ collected, llmResult, run, row, config }) {
    const findings = llmResult.findings || [];
    const pkgs = llmResult.packages || [];
    for (const f of findings) {
      const { finding, isNew } = await upsertFinding({ models, run, finding: f, config });
      if (!isNew) continue; // Dedup match — skip actions/notifications
      // Create a pending action for upgrades
      if (f.suggestedFix === "apt.upgrade" && pkgs.length) {
        await models.SkillAction.create({
          skillRunId: run.id, findingId: finding.id,
          actionType: "apt.upgrade",
          target: "packages",
          parameters: JSON.stringify({ packages: pkgs }),
          status: "pending",
        });
      }
    }
    if (pkgs.length) {
      await models.Notification.create({
        skillRunId: run.id, severity: pkgs.length > 5 ? "warning" : "info",
        title: `${pkgs.length} package update(s) available`,
        message: pkgs.slice(0, 20).join(", ") + (pkgs.length > 20 ? ` +${pkgs.length - 20} more` : ""),
      });
    }
    await run.update({
      status: "completed", finishedAt: new Date(),
      summary: llmResult.summary || `${pkgs.length} package update(s)`,
    });
  },
};
