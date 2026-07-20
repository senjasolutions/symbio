/**
 * Skill scheduler — runs skill execution loops on intervals.
 * Reads enabled skills from DB, loads their module, and calls the lifecycle:
 *   collect → filter → analyze (LLM) → report
 * Passes config and memory to each module.
 */

import { models } from "../../db/index.js";
import { getSkillModule, registerSkill } from "./index.js";
import { collectSkillData, executeSkillActions } from "../agent-client.js";

import errorFinderModule from "./error-finder.js";
import storageMaidModule from "./storage-maid.js";
import packageUpdaterModule from "./package-updater.js";
import uptimePoliceModule from "./uptime-police.js";
import optimizerModule from "./optimizer.js";
import susFinderModule from "./sus-finder.js";

registerSkill("error-finder", errorFinderModule);
registerSkill("storage-maid", storageMaidModule);
registerSkill("package-updater", packageUpdaterModule);
registerSkill("uptime-police", uptimePoliceModule);
registerSkill("optimizer", optimizerModule);
registerSkill("sus-finder", susFinderModule);

const timers = new Map();
/** Tracks currently executing skill runs with phase/progress detail. */
const runningTasks = new Map();
/** Skills flagged for cancellation — checked between lifecycle phases. */
const killedSkills = new Set();
const agentClient = { collectSkillData, executeSkillActions };

/** Reads LLM config from settings for skill AI calls. */
const readLlmConfig = async () => {
  const row = await models.Setting.findByPk("llm_config");
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
};

/** Parses a cron-like pattern into milliseconds. */
const parseInterval = (schedule) => {
  if (!schedule) return null;
  const num = Number(schedule);
  if (Number.isInteger(num)) return num;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    if (parts[0] === "*" && parts[1] === "*") return 60_000;
    const minMatch = parts[0].match(/^\*$/) || parts[0].match(/^\*\/(\d+)$/);
    const hourMatch = parts[1].match(/^\*\/(\d+)$/);
    const minMinute = parts[0].match(/^\d+$/);
    if (hourMatch) return parseInt(hourMatch[1]) * 3_600_000;
    if (minMatch && minMatch[1]) return parseInt(minMatch[1]) * 60_000;
    if (minMinute && parts[1] === "*") return 3_600_000; // "0 * * * *" = every hour on the hour
    if (minMinute) return 24 * 3_600_000; // "0 0 * * *" = once daily at specific time
    if (parts[1] && parts[1].startsWith("*/")) {
      const h = parseInt(parts[1].slice(2));
      if (h > 0) return h * 3_600_000;
    }
    return 60_000;
  }
  return null;
};

/** Resolves the actual interval for a skill: config override > DB schedule. */
const resolveInterval = (skillRow) => {
  let cfg = {};
  try {
    const raw = skillRow.config || "{}";
    cfg = typeof raw === "object" ? raw : JSON.parse(raw);
  } catch {}
  if (cfg.checkIntervalSeconds) return cfg.checkIntervalSeconds * 1000;
  return parseInterval(skillRow.scheduleInterval);
};

/** Parses skill config JSON safely. Handles both stored strings and Sequelize auto-parsed objects. */
const parseConfig = (row) => {
  const val = row.config || "{}";
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return {}; }
};

/** Logs a structured message with timestamp, skill key, phase, and detail. NSA-level. */
const log = (skillKey, phase, message, extra) => {
  const ts = new Date().toISOString();
  const parts = [`[${ts}]`, `[${skillKey}]`, `[${phase}]`, message];
  if (extra) parts.push(JSON.stringify(extra));
  console.log(parts.join(" "));
};

/** Runs a full skill cycle through the module lifecycle. */
const runSkill = async (skillKey, trigger = "scheduled") => {
  if (runningTasks.has(skillKey)) { log(skillKey, "skip", "Already running"); return; }
  let run = null;
  const taskInfo = { skillKey, phase: "starting", startedAt: new Date(), skillRunId: null, detail: "" };
  runningTasks.set(skillKey, taskInfo);
  try {
    const row = await models.Skill.findOne({ where: { key: skillKey } });
    if (!row || !row.enabled) { log(skillKey, "abort", "Skill not found or disabled"); finishTask(skillKey); return; }
    const mod = getSkillModule(skillKey);
    if (!mod) { log(skillKey, "abort", "No module registered"); finishTask(skillKey); return; }

    const config = parseConfig(row);
    const memory = row.memory || "";
    log(skillKey, "start", `Config interval=${config.checkIntervalSeconds || "default"}s, memory=${memory.length} chars`);

    run = await models.SkillRun.create({
      skillId: row.id, trigger, status: "running", startedAt: new Date(),
    });
    taskInfo.skillRunId = run.id;
    log(skillKey, "run", `SkillRun #${run.id} created`);

    // 1. Check agent health before collecting data
    if (killedSkills.has(skillKey)) { await cancelRun(run, skillKey); finishTask(skillKey); return; }
    taskInfo.phase = "connecting";
    taskInfo.detail = "Checking agent connectivity...";
    const agentUrl = process.env.SYMBIO_AGENT_BRIDGE_URL || process.env.SYMBIO_AGENT_URL || "http://host.docker.internal:18768";
    try {
      await fetch(`${agentUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    } catch {
      log(skillKey, "warn", `Agent unreachable at ${agentUrl}`);
      await run.update({ status: "completed", finishedAt: new Date(), summary: "Agent unreachable — will retry on next interval." });
      finishTask(skillKey);
      return;
    }
    taskInfo.phase = "collecting";
    taskInfo.detail = "Gathering data from host...";
    log(skillKey, "collect", "Starting host data collection...");
    let collected;
    try {
      collected = await mod.collect(agentClient, config);
    } catch (colError) {
      log(skillKey, "error", `Collection failed: ${colError.message}`);
      await run.update({ status: "completed", finishedAt: new Date(), summary: `Collection failed: ${colError.message.slice(0, 200)}` });
      finishTask(skillKey);
      return;
    }
    log(skillKey, "collect", `Collected data types: ${Object.keys(collected).join(", ")}`);

    // 2. Pre-filter
    if (killedSkills.has(skillKey)) { await cancelRun(run, skillKey); finishTask(skillKey); return; }
    taskInfo.phase = "filtering";
    taskInfo.detail = "Evaluating collected data...";
    const shouldProceed = await mod.filter(collected, config);
    log(skillKey, "filter", `Should proceed: ${shouldProceed}`);
    if (!shouldProceed) {
      await run.update({ status: "completed", finishedAt: new Date(), summary: "No action needed." });
      log(skillKey, "done", "Filter returned false — no action needed");
      finishTask(skillKey);
      return;
    }

    // 3. Analyze via LLM
    const llmConfig = await readLlmConfig();
    if (!llmConfig) {
      await run.update({ status: "completed", finishedAt: new Date(), summary: "LLM not configured." });
      log(skillKey, "done", "LLM not configured");
      finishTask(skillKey);
      return;
    }
    // Normalize: DB stores secretKey, skill modules expect apiKey
    llmConfig.apiKey = llmConfig.apiKey || llmConfig.secretKey;
    if (!llmConfig.apiKey) {
      await run.update({ status: "completed", finishedAt: new Date(), summary: "LLM not configured — no API key found." });
      log(skillKey, "done", "LLM not configured — no apiKey or secretKey in config");
      finishTask(skillKey);
      return;
    }
    if (killedSkills.has(skillKey)) { await cancelRun(run, skillKey); finishTask(skillKey); return; }
    taskInfo.phase = "analyzing";
    taskInfo.detail = `LLM (${llmConfig.model || "default"}) analyzing data...`;
    log(skillKey, "analyze", `Calling LLM model=${llmConfig.model || "default"}`);
    const llmResult = await mod.analyze(collected, llmConfig, config, memory);
    const findings = llmResult.findings || [];
    log(skillKey, "analyze", `LLM returned ${findings.length} findings, usage=${JSON.stringify(llmResult.usage || {})}`);

    // Track LLM usage — log each call to token_usage table for billing analysis
    if (llmResult.usage) {
      await models.TokenUsage.create({
        skillId: row.id, skillRunId: run.id, skillKey: row.key,
        model: llmConfig.model || "",
        promptTokens: llmResult.usage.promptTokens || 0,
        completionTokens: llmResult.usage.completionTokens || 0,
        totalTokens: llmResult.usage.totalTokens || 0,
        source: "skill",
        createdAt: new Date(),
      });
      log(skillKey, "usage", `Logged ${llmResult.usage.totalTokens || 0} tokens to token_usage`);
    }

    // Update memory if LLM returned new memory context
    if (llmResult.newMemory) {
      const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const newEntry = `[${timestamp}] ${llmResult.newMemory.slice(0, 500)}`;
      const updated = memory ? `${memory}\n${newEntry}` : newEntry;
      const trimmed = updated.slice(-2000);
      await models.Skill.update({ memory: trimmed }, { where: { id: row.id } });
      log(skillKey, "memory", `Memory updated: +${newEntry.length} chars`);
    }

    // 4. Report — save findings, actions, notifications
    if (killedSkills.has(skillKey)) { await cancelRun(run, skillKey); finishTask(skillKey); return; }
    taskInfo.phase = "reporting";
    taskInfo.detail = "Saving findings and actions...";
    await mod.report({ collected, llmResult, run, row, config });
    log(skillKey, "report", `Reported ${findings.length} findings`);

    // 5. Execute — auto-execute low-risk actions (self-healing)
    if (killedSkills.has(skillKey)) { await cancelRun(run, skillKey); finishTask(skillKey); return; }
    if (typeof mod.execute === "function" && llmResult.findings?.length) {
      taskInfo.phase = "executing";
      taskInfo.detail = "Auto-executing low-risk actions...";
      try {
        const execResults = await mod.execute(llmResult.findings, agentClient);
        if (execResults?.length) log(skillKey, "execute", `Auto-executed ${execResults.length} action(s)`);
      } catch (execError) {
        log(skillKey, "warn", `Auto-execution error: ${execError.message.slice(0, 200)}`);
      }
    }

  } catch (error) {
    log(skillKey, "error", error.message, { stack: error.stack?.split("\n").slice(0, 3).join(" | ") });
    try {
      if (run && run.id) {
        // Update existing run — fixes the stale "running" record bug
        await run.update({
          status: "failed", finishedAt: new Date(),
          errorMessage: error.message.slice(0, 500),
          summary: `Failed: ${error.message.slice(0, 200)}`,
        });
        log(skillKey, "error", `SkillRun #${run.id} marked as failed`);
      } else {
        // Run was never created (error happened before SkillRun.create)
        const row = await models.Skill.findOne({ where: { key: skillKey } });
        if (row) {
          await models.SkillRun.create({
            skillId: row.id, trigger, status: "failed",
            startedAt: new Date(), finishedAt: new Date(),
            errorMessage: error.message.slice(0, 500),
          });
          log(skillKey, "error", "Created new failed SkillRun (run was null)");
        }
      }
    } catch (innerErr) {
      log(skillKey, "error", `Failed to record failure: ${innerErr.message}`, { innerStack: innerErr.stack?.split("\n").slice(0, 2).join(" | ") });
    }
  } finally {
    // Keep task visible for 3 seconds so the UI can render it
    taskInfo.phase = taskInfo.phase === "starting" ? "failed" : taskInfo.phase;
    taskInfo.detail = taskInfo.detail || (run?.status === "failed" ? "Failed — see recent activity" : "Completed");
    // Only set failed if there was an error — cancelled/completed runs are not "failed"
    if (run && run.status === "failed") taskInfo.runOutcome = "failed";
    setTimeout(() => {
      runningTasks.delete(skillKey);
      killedSkills.delete(skillKey);
    }, 3000);
  }
};

/** Removes a task from the runningTasks map immediately. */
const finishTask = (skillKey) => {
  runningTasks.delete(skillKey);
};

/** Marks a run as cancelled and cleans up. Keeps visible for 3s in the UI. */
const cancelRun = async (run, skillKey) => {
  try {
    await run.update({ status: "cancelled", finishedAt: new Date(), summary: "Cancelled by user." });
    log(skillKey, "cancel", `SkillRun #${run.id} cancelled by user`);
  } catch (e) {
    log(skillKey, "cancel", `Failed to cancel: ${e.message}`);
  }
  killedSkills.delete(skillKey);
  // Keep cancelled visible briefly too — cleanup also handled by finally block's 3s timeout
  setTimeout(() => finishTask(skillKey), 2000);
};

/** Starts the scheduler for a single skill. First run happens on the first interval tick, not immediately. */
const startSkill = async (skillRow) => {
  const ms = resolveInterval(skillRow);
  if (!ms || ms < 10_000) return;
  if (timers.has(skillRow.key)) clearInterval(timers.get(skillRow.key));
  // Only set the timer — no immediate run. This prevents a flood of "fetch failed"
  // errors when the mothership starts before the agent container is ready.
  const timer = setInterval(() => runSkill(skillRow.key).catch((err) => console.error(`[scheduler] ${skillRow.key} run failed:`, err.message)), ms);
  timer.unref();
  timers.set(skillRow.key, timer);
};

const stopSkill = (skillKey) => {
  if (timers.has(skillKey)) { clearInterval(timers.get(skillKey)); timers.delete(skillKey); }
};

const ensureAllSkills = async () => {
  const defaults = [
    {
      key: "package-updater", name: "Package Updater",
      description: "Check for available package updates, prioritize security patches, and apply them safely.",
      icon: "fa-solid fa-box",
      scheduleInterval: "0 */6 * * *", safetyTier: "confirm",
      config: '{}',
    },
    {
      key: "storage-maid", name: "Storage Maid",
      description: "Monitor disk usage, identify space hogs, and perform safe cleanup.",
      icon: "fa-solid fa-hard-drive",
      scheduleInterval: "0 */2 * * *", safetyTier: "auto",
      config: '{}',
    },
    {
      key: "uptime-police", name: "Uptime Police",
      description: "Monitor service health and restart frozen services automatically.",
      icon: "fa-solid fa-heart-pulse",
      scheduleInterval: "* * * * *", safetyTier: "auto",
      config: '{}',
    },
    {
      key: "error-finder", name: "Error Finder",
      description: "Scan system and application logs for errors and report findings.",
      icon: "fa-solid fa-magnifying-glass",
      scheduleInterval: "*/10 * * * *", safetyTier: "confirm",
      config: '{}',
    },
    {
      key: "optimizer", name: "Optimizer",
      description: "Find performance, security, and stability optimizations.",
      icon: "fa-solid fa-gauge-high",
      scheduleInterval: "0 */24 * * *", safetyTier: "confirm",
      config: '{}',
    },
    {
      key: "sus-finder", name: "SUS Finder",
      description: "Scan for suspicious activity: brute force attacks, malware, unusual connections, and compromise signs.",
      icon: "/img/providers/sus-finder.svg",
      scheduleInterval: "0 * * * *", safetyTier: "confirm",
      config: '{}',
    },
  ];
  const skipKeys = new Set();
  const existing = await models.Skill.findAll({ attributes: ["key"] });
  for (const s of existing) skipKeys.add(s.key);
  for (const d of defaults) {
    if (skipKeys.has(d.key)) continue;
    await models.Skill.create({
      ...d, enabled: true, memory: "",
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
};

export const initScheduler = async () => {
  await ensureAllSkills();
  // Grace period: wait up to 15s for the agent bridge to become reachable
  // before starting skill intervals. Prevents "fetch failed" floods when the
  // mothership container starts before the agent is ready.
  const agentUrl = process.env.SYMBIO_AGENT_BRIDGE_URL || process.env.SYMBIO_AGENT_URL || "http://host.docker.internal:18768";
  let agentReady = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${agentUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      agentReady = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!agentReady) {
    console.log(`[SkillScheduler] Agent not reachable at ${agentUrl} after 15s — skills will run on their first interval tick`);
  }
  const skills = await models.Skill.findAll({ where: { enabled: true } });
  for (const skill of skills) startSkill(skill);
  console.log(`[SkillScheduler] Started ${skills.length} skill(s), agent ${agentReady ? "ready" : "unreachable"}`);
};

export const stopScheduler = () => {
  for (const key of timers.keys()) stopSkill(key);
};

export const runNow = async (skillKey) => {
  const row = await models.Skill.findOne({ where: { key: skillKey } });
  if (!row) throw new Error(`Skill "${skillKey}" not found`);
  if (runningTasks.has(skillKey)) throw new Error(`Skill "${skillKey}" is already running`);
  runSkill(skillKey).catch((error) => console.error(`[scheduler] runNow error for ${skillKey}:`, error.message));
};

/** Returns a snapshot of currently running tasks with their phase and duration. */
export const getRunningTasks = () => {
  const tasks = [];
  for (const [key, info] of runningTasks) {
    tasks.push({
      skillKey: key,
      phase: info.phase,
      detail: info.detail,
      skillRunId: info.skillRunId,
      startedAt: info.startedAt,
      duration: Math.round((Date.now() - info.startedAt.getTime()) / 1000),
      runOutcome: info.runOutcome || null,
    });
  }
  return tasks;
};

/** Flags a running skill for cancellation at the next phase boundary. */
export const killSkill = async (skillKey) => {
  if (runningTasks.has(skillKey)) {
    killedSkills.add(skillKey);
    return true;
  }
  return false;
};

/**
 * Triggers a skill run from an alert rule's self-healing action.
 * Fire-and-forget — does not block the caller. Guards against:
 * - Skill not found or disabled
 * - Skill already running (concurrent run prevention)
 */
export const triggerHealSkill = async (skillKey) => {
  const row = await models.Skill.findOne({ where: { key: skillKey } });
  if (!row || !row.enabled) {
    return;
  }
  if (runningTasks.has(skillKey)) {
    return;
  }
  runSkill(skillKey, "alert").catch((error) => console.error(`[heal] ${skillKey} failed:`, error.message));
};

export const refreshSkill = async (skillKey) => {
  const row = await models.Skill.findOne({ where: { key: skillKey } });
  if (!row) { stopSkill(skillKey); return; }
  if (row.enabled) startSkill(row);
  else stopSkill(skillKey);
};
