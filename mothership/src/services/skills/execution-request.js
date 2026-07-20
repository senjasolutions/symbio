/**
 * Execution Request module — modular confirmation layer before running commands.
 *
 * On "Apply", this creates an ExecutionRequest record with the exact commands,
 * an AI-generated explanation of what they do, risk level, and affected systems.
 * The user reviews this before confirming execution — maximum assurance and control.
 *
 * Designed to be reusable for any future feature that needs user confirmation
 * before executing host commands (manual actions, one-click fixes, etc.).
 */

import { models } from "../../db/index.js";
import { callSkillAI } from "../llm.service.js";

/**
 * Maps an action_type + parameters to the exact shell commands the agent will run.
 * Mirrors the agent's skills-executor.js whitelist to ensure accuracy.
 *
 * @param {string} actionType - The action_type from skill_actions
 * @param {object} params - Parsed action.parameters JSON
 * @param {string} [target] - Action target column (service name, file path)
 * @returns {string[]} Array of shell command strings shown to the user
 */
export function buildCommands(actionType, params = {}, target = "") {
  switch (actionType) {
    case "apt.upgrade": {
      const pkgs = Array.isArray(params.packages) ? params.packages.filter(Boolean) : [];
      if (pkgs.length) return [`apt-get upgrade -y --only-upgrade ${pkgs.join(" ")}`];
      return ["apt-get upgrade -y"];
    }
    case "apt.clean":
      return ["apt-get clean"];
    case "apt.autoremove":
      return ["apt-get autoremove -y"];
    case "journalctl.vacuum":
      return ["journalctl --vacuum-time=7d"];
    case "systemctl.restart": {
      const svc = target || params.service || "";
      return svc ? [`systemctl restart ${svc}`] : [];
    }
    case "file.truncate": {
      const p = params.target || target || "";
      return p ? [`truncate -s 0 ${p}`] : [];
    }
    case "file.remove": {
      const p = params.target || target || "";
      return p ? [`rm -f ${p}`] : [];
    }
    case "config.change": {
      const cmds = Array.isArray(params.commands) ? params.commands : [];
      return cmds.length ? cmds : [];
    }
    case "docker.restart": {
      const c = params.container || target || "";
      return c ? [`docker restart ${c}`] : [];
    }
    case "docker.stop": {
      const c = params.container || target || "";
      return c ? [`docker stop ${c}`] : [];
    }
    case "docker.prune":
      return ["docker system prune -f"];
    case "docker.prune-images":
      return ["docker image prune -f"];
    case "docker.prune-volumes":
      return ["docker volume prune -f"];
    case "docker.pull": {
      const img = params.image || "";
      return img ? [`docker pull ${img}`] : [];
    }
    default:
      return [];
  }
}

/**
 * Generates a display ID in the format EXR-YYYYMMDD-NNN (sequential per day).
 *
 * @param {object} sequelize - Sequelize instance for DB query
 * @returns {Promise<string>} e.g. "EXR-20072026-001"
 */
export async function generateDisplayId(sequelize) {
  const today = new Date();
  const y = String(today.getUTCFullYear());
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const prefix = `EXR-${y}${m}${d}-`;

  const [rows] = await sequelize.query(
    `SELECT display_id FROM execution_requests WHERE display_id LIKE ? ORDER BY display_id DESC LIMIT 1`,
    { replacements: [`${prefix}%`] },
  );

  let seq = 1;
  if (rows.length) {
    const last = rows[0].display_id || rows[0].displayId || "";
    const num = parseInt(last.replace(prefix, ""), 10);
    if (!isNaN(num)) seq = num + 1;
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

/**
 * Calls the LLM to generate a human-readable explanation of what the commands do,
 * the risk level, and what systems are affected.
 *
 * Falls back to a simple description if the LLM is not configured.
 *
 * @param {object|null} llmConfig - LLM config from settings
 * @param {string[]} commands - Shell commands to explain
 * @param {string} actionType - The action_type
 * @param {string} context - Additional context (finding title, description)
 * @returns {Promise<{explanation: string, riskLevel: string, affected: string}>}
 */
export async function generateExplanation(llmConfig, commands, actionType, context = "") {
  if (!llmConfig?.apiKey || !llmConfig?.provider) {
    return fallbackExplanation(actionType);
  }

  const cmdList = commands.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const systemPrompt = `You are a Linux system administrator explaining commands to a user.
Given the commands below, explain in plain English:
1. What each command does (one clear, concise sentence)
2. Risk level: "low", "medium", or "high" — consider whether this could cause downtime, data loss, or break services
3. What systems, services, or files are affected (comma-separated list)

Respond ONLY with valid JSON: {"explanation": "...", "riskLevel": "low|medium|high", "affected": "..."}`;

  const dataContent = `Action type: ${actionType}\n${context ? `Context: ${context}\n` : ""}Commands:\n${cmdList}`;

  try {
    const result = await callSkillAI({
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint,
      model: llmConfig.model,
      systemPrompt,
      dataContent,
      maxTokens: 512,
      language: llmConfig.language,
      personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return fallbackExplanation(actionType);
    const parsed = JSON.parse(result.content);
    return {
      explanation: parsed.explanation || "",
      riskLevel: ["low", "medium", "high"].includes(parsed.riskLevel) ? parsed.riskLevel : "low",
      affected: parsed.affected || "",
    };
  } catch {
    return fallbackExplanation(actionType);
  }
}

/**
 * Handles an AI revision request — the user asks the AI to adjust the commands.
 * Returns updated commands, explanation, risk level, and affected systems.
 *
 * @param {object|null} llmConfig - LLM config
 * @param {string[]} currentCommands - Current command list
 * @param {string} actionType - Action type
 * @param {string} userMessage - The user's revision request
 * @param {Array} [revisionHistory] - Previous revision messages for context
 * @returns {Promise<{commands: string[], explanation: string, riskLevel: string, affected: string}>}
 */
export async function reviseCommands(llmConfig, currentCommands, actionType, userMessage, revisionHistory = []) {
  if (!llmConfig?.apiKey) {
    return { commands: currentCommands, explanation: "", riskLevel: "low", affected: "" };
  }

  const historyText = revisionHistory.length
    ? revisionHistory.map((m) => `${m.role}: ${m.message}`).join("\n")
    : "";

  const cmdList = currentCommands.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const systemPrompt = `You are a Linux system administrator helping a user adjust commands.
Based on the current commands and the user's revision request, provide the revised command list.
You may add, remove, or modify commands as appropriate. Always prefer safe, idempotent operations.

Respond ONLY with valid JSON:
{"commands": ["cmd1", "cmd2"], "explanation": "What the revised commands do", "riskLevel": "low|medium|high", "affected": "what is affected"}`;

  const dataContent = [
    `Action type: ${actionType}`,
    `Current commands:\n${cmdList}`,
    historyText ? `Previous discussion:\n${historyText}` : "",
    `\nUser's revision request: ${userMessage}`,
  ].filter(Boolean).join("\n\n");

  try {
    const result = await callSkillAI({
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      endpoint: llmConfig.endpoint,
      model: llmConfig.model,
      systemPrompt,
      dataContent,
      maxTokens: 1024,
      language: llmConfig.language,
      personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) return { commands: currentCommands, explanation: "", riskLevel: "low", affected: "" };
    const parsed = JSON.parse(result.content);
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter(Boolean) : currentCommands,
      explanation: parsed.explanation || "",
      riskLevel: ["low", "medium", "high"].includes(parsed.riskLevel) ? parsed.riskLevel : "low",
      affected: parsed.affected || "",
    };
  } catch {
    return { commands: currentCommands, explanation: "", riskLevel: "low", affected: "" };
  }
}

/** Fallback explanation when LLM is unavailable — simple descriptions per action type. */
function fallbackExplanation(actionType) {
  const map = {
    "apt.upgrade": { explanation: "Upgrades specified packages to their latest available versions.", riskLevel: "low", affected: "Installed packages" },
    "apt.clean": { explanation: "Clears the APT package cache to free disk space.", riskLevel: "low", affected: "Disk space, APT cache" },
    "apt.autoremove": { explanation: "Removes packages that were automatically installed and are no longer needed.", riskLevel: "low", affected: "Installed packages, Disk space" },
    "journalctl.vacuum": { explanation: "Removes old journal log entries to free disk space, keeping only the most recent.", riskLevel: "low", affected: "System logs, Disk space" },
    "systemctl.restart": { explanation: "Restarts the specified system service. May cause brief downtime for that service.", riskLevel: "medium", affected: "System service" },
    "file.truncate": { explanation: "Empties the contents of a file while preserving the file itself.", riskLevel: "low", affected: "File contents, Disk space" },
    "file.remove": { explanation: "Deletes the specified file permanently.", riskLevel: "low", affected: "File system" },
    "config.change": { explanation: "Applies system configuration changes such as kernel parameters or sysctl settings.", riskLevel: "medium", affected: "System configuration, kernel parameters" },
    "docker.restart": { explanation: "Restarts the specified Docker container. Brief downtime for that container.", riskLevel: "medium", affected: "Docker container" },
    "docker.stop": { explanation: "Stops the specified Docker container. The container will remain stopped until manually restarted.", riskLevel: "medium", affected: "Docker container" },
    "docker.prune": { explanation: "Removes unused Docker objects including stopped containers, unused images, and build cache.", riskLevel: "low", affected: "Docker storage, unused resources" },
    "docker.prune-images": { explanation: "Removes unused Docker images that are not referenced by any container.", riskLevel: "low", affected: "Docker image storage" },
    "docker.prune-volumes": { explanation: "Removes unused Docker volumes that are not referenced by any container. May cause data loss.", riskLevel: "medium", affected: "Docker volume storage" },
    "docker.pull": { explanation: "Pulls the latest version of a Docker image from the configured registry.", riskLevel: "low", affected: "Docker image storage" },
  };
  return map[actionType] || { explanation: "Executes the requested action on the server.", riskLevel: "low", affected: "Server" };
}
