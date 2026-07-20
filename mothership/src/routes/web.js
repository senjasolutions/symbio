/**
 * Public web routes implement the complete server-rendered Phase 1 workflow;
 * JavaScript only enhances current-status refresh and is never required for CRUD.
 */

import { Hono } from "hono";
import { Op, QueryTypes } from "sequelize";
import fs from "node:fs";
import { createSession, destroySession, requireApiAuth, requireAuth, requireCsrf, resolveSession } from "../lib/auth.js";
import { bucketSeries, chartRange, renderLineChart } from "../lib/charts.js";
import { formatBytes, formatPercent, formatUptime, rollingAverage } from "../lib/format.js";
import { renderPage, resolveI18n } from "../lib/render.js";
import { THEME_CHOICES } from "../lib/render.js";
import { LANGUAGE_CHOICES } from "../lib/i18n.js";
import { renderMarkdown } from "../lib/markdown.js";
import { clearLoginFailures, loginAllowed, recordLoginFailure, requestAddress } from "../lib/security.js";
import { hashPassword, verifyPassword } from "../lib/password.js";

/** Maps provider keys to their logo SVG paths for UI display. */
const PROVIDER_LOGOS = {
  deepseek: "/img/providers/deepseek.svg",
  openai: "/img/providers/openai.svg",
  anthropic: "/img/providers/anthropic.svg",
};

/** Resolves a model name to its provider logo path. Returns null if unknown. */
const modelLogo = (model) => {
  if (!model) return null;
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    if (models.includes(model)) return PROVIDER_LOGOS[provider] || null;
  }
  return null;
};
import { models, sequelize } from "../db/index.js";
import { config } from "../config.js";
import { readApplicationLog, searchApplicationLog } from "../services/agent-log.service.js";
import { listDirectory, readFile, getDirectoryTree, viewFile } from "../services/file-manager.service.js";
import { createEntry, writeFile as writeFileService, deleteEntry, renameEntry, changeMode } from "../services/file-manager.service.js";
import { fetchServerInfo, fetchProcessList, fetchListeningPorts, fetchMemoryDetail, fetchDiskIO, fetchLoggedInUsers, fetchInstalledPackages } from "../services/system.service.js";
import { serviceRegistry } from "../components/services/index.js";
import { readSystemLog, searchSystemLog } from "../services/system-log.service.js";
import { readMothershipLog, searchMothershipLog, readAgentLog, searchAgentLog } from "../services/symbio-log.service.js";
import { askAI, checkBalance, discoverApplications, buildDiscoveryContext, buildSystemPrompt, PROVIDER_MODELS } from "../services/llm.service.js";
import { executeSkillActions } from "../services/agent-client.js";
import { executeWithProof } from "../services/skills/proof.js";
import { buildCommands, generateDisplayId, generateExplanation, reviseCommands } from "../services/skills/execution-request.js";

const router = new Hono();
const LOG_TAIL_LIMITS = [50, 100, 200, 500, 1000];

/** Parses persisted JSON defensively so an old or malformed row cannot break SSR. */
const parseJson = (value, fallback) => { try { const parsed = JSON.parse(value || ""); return parsed ?? fallback; } catch { return fallback; } };
/** Narrows JSON values expected as persisted arrays for safe template iteration. */
const parseArray = (value) => { const parsed = parseJson(value, []); return Array.isArray(parsed) ? parsed : []; };

/** Checks whether the LLM settings row has both a provider and a secret key. */
const isLlmConfigured = async () => {
  const row = await models.Setting.findByPk("llm_config");
  if (!row) return false;
  try { const cfg = JSON.parse(row.value); return Boolean(cfg.provider && cfg.secretKey); } catch { return false; }
};

/** Reads current token usage counter from the settings table. */
const readLlmUsage = async () => {
  const rows = await models.TokenUsage.findAll({
    attributes: [
      [sequelize.fn("COALESCE", sequelize.fn("SUM", sequelize.col("total_tokens")), 0), "totalTokens"],
      [sequelize.fn("COALESCE", sequelize.fn("SUM", sequelize.col("prompt_tokens")), 0), "promptTokens"],
      [sequelize.fn("COALESCE", sequelize.fn("SUM", sequelize.col("completion_tokens")), 0), "completionTokens"],
      [sequelize.fn("COUNT", sequelize.col("id")), "requestCount"],
    ],
    raw: true,
  });
  const r = rows[0] || {};
  return { totalTokens: Number(r.totalTokens) || 0, promptTokens: Number(r.promptTokens) || 0, completionTokens: Number(r.completionTokens) || 0, requestCount: Number(r.requestCount) || 0 };
};

/** Reads the current setup wizard state from settings, defaulting to incomplete step 1. */
const readWizardState = async () => {
  const row = await models.Setting.findByPk("setup_wizard");
  if (!row) return { completed: false, step: 1 };
  try { return JSON.parse(row.value); } catch { return { completed: false, step: 1 }; }
};

/** Persists setup wizard state to the settings table. */
const writeWizardState = async (state) => {
  await models.Setting.upsert({ key: "setup_wizard", value: JSON.stringify(state), updatedAt: new Date() });
};

/** Shorthand to check if the current user is superadmin. */
const isSuperadmin = (context) => context.get("auth")?.user?.role === "superadmin";

/** Loads pending skill actions with skill info via JOIN, for the actions page or Command Center preview. */
const loadPendingActions = async () => {
  const [actions] = await sequelize.query(`
    SELECT sa.id, sa.skill_run_id, sa.finding_id, sa.action_type, sa.target,
           sa.parameters, sa.status, sa.result, sa.created_at,
           s.name as skill_name, s.icon as skill_icon, s.key as skill_key,
           sf.title as finding_title, sf.description as finding_description,
           sf.seen_count as seen_count, sf.pattern as finding_pattern
    FROM skill_actions sa
    JOIN skill_runs sr ON sa.skill_run_id = sr.id
    JOIN skills s ON sr.skill_id = s.id
    LEFT JOIN skill_findings sf ON sa.finding_id = sf.id
    WHERE sa.status = 'pending'
    ORDER BY sa.created_at DESC
    LIMIT 100
  `);
  return actions.map((a) => formatAction(a));
};

/** Formats a single skill action for template display. */
const formatAction = (a) => {
  const skillName = a.skill_name || "Unknown";
  const skillIcon = a.skill_icon || "fa-solid fa-gear";
  let params = {};
  try { params = JSON.parse(a.parameters || "{}"); } catch {}
  const riskLevel = params.riskLevel || "low";
  const riskBadgeClass = riskLevel === "high" ? "text-bg-danger" : riskLevel === "medium" ? "text-bg-warning" : "text-bg-info";
  let result = {};
  try { result = JSON.parse(a.result || "{}"); } catch {}
  const hasProof = result.beforeSummary && result.afterSummary;
  const created = a.created_at || a.createdAt;
  const findingTitle = a.finding_title || "";
  const findingDesc = a.finding_description || "";
  const paramMessage = params.message || "";
  const title = findingTitle || paramMessage || a.action_type || "Action";
  const description = findingDesc || "";
  // Skills whose actions are finding-only — no meaningful Apply button
  const nonExecutableSkills = ["sus-finder", "error-finder", "optimizer"];
  const isExecutable = !nonExecutableSkills.includes(a.skill_key || "");
  const seenCount = parseInt(a.seen_count) || 1;
  return {
    id: a.id,
    skillName,
    skillIcon,
    skillIconImg: !skillIcon.startsWith("fa-"),
    title,
    description,
    riskLabel: riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1),
    riskBadgeClass,
    createdAt: created ? new Date(created).toLocaleString() : "—",
    status: a.status,
    hasProof,
    isExecutable,
    beforeSummary: result.beforeSummary || "",
    afterSummary: result.afterSummary || "",
    diff: result.diff || "",
    hasPattern: !!params.pattern,
    seenCount,
    seenCountMore: seenCount > 1,
  };
};

/** Safely parses a skill config JSON string. Handles both stored strings and Sequelize auto-parsed objects. */
const parseConfig = (json) => {
  if (json && typeof json === "object") return json;
  try { return JSON.parse(json || "{}"); } catch { return {}; }
};

/** Decorates config booleans for Mustache templates (e.g. intensitySafe, intensityModerate). */
const decorateConfig = (skillKey, config) => {
  const result = { ...config };
  // Arrays must be handled specially for Mustache iteration
  if (Array.isArray(config.excludeDirs)) result.excludeDirs = config.excludeDirs;
  else if (typeof config.excludeDirs === "string") result.excludeDirs = config.excludeDirs.split("\n").filter(Boolean);
  else result.excludeDirs = [];

  if (Array.isArray(config.monitoredServices)) result.monitoredServices = config.monitoredServices;
  else if (typeof config.monitoredServices === "string") result.monitoredServices = config.monitoredServices.split("\n").filter(Boolean);
  else result.monitoredServices = [];

  if (Array.isArray(config.logSources)) result.logSources = config.logSources;
  else if (typeof config.logSources === "string") result.logSources = config.logSources.split("\n").filter(Boolean);
  else result.logSources = [];

  if (Array.isArray(config.ignorePatterns)) result.ignorePatterns = config.ignorePatterns;
  else if (typeof config.ignorePatterns === "string") result.ignorePatterns = config.ignorePatterns.split("\n").filter(Boolean);
  else result.ignorePatterns = [];

  if (Array.isArray(config.ignoredPackages)) result.ignoredPackages = config.ignoredPackages;
  else if (typeof config.ignoredPackages === "string") result.ignoredPackages = config.ignoredPackages.split("\n").filter(Boolean);
  else result.ignoredPackages = [];

  // SUS Finder config
  result.checkAuthLog = config.checkAuthLog !== false;
  result.checkProcesses = config.checkProcesses !== false;
  result.checkPorts = config.checkPorts !== false;
  result.checkCrontabs = config.checkCrontabs !== false;
  result.checkFailedLogins = config.checkFailedLogins !== false;
  result.maxAuthLogLines = config.maxAuthLogLines || 300;
  result.maxFailedLogins = config.maxFailedLogins || 50;
  if (Array.isArray(config.ignorePatterns)) result.ignorePatterns = config.ignorePatterns;
  else result.ignorePatterns = [];

  // Boolean decorators for select options
  result.intensitySafe = config.intensity !== "moderate";
  result.intensityModerate = config.intensity === "moderate";
  result.cleanDepthLight = config.cleanDepth !== "standard" && config.cleanDepth !== "deep";
  result.cleanDepthStandard = config.cleanDepth === "standard";
  result.cleanDepthDeep = config.cleanDepth === "deep";
  result.minRiskLevelLow = config.minRiskLevel !== "medium";
  result.minRiskLevelMedium = config.minRiskLevel === "medium";
  result.dryRunOnly = config.dryRunOnly === true;
  result.autoRestart = config.autoRestart === true;

  // Convert seconds to user-friendly value + unit for the interval input
  // Per-skill defaults: package-updater=weekly, storage-maid=daily, optimizer=daily,
  // sus-finder=hourly, error-finder=2h, uptime-police=15m, others=5m
  const defaultSec = {
    "package-updater": 604800, "storage-maid": 86400, "optimizer": 86400,
    "sus-finder": 3600, "error-finder": 7200, "uptime-police": 900,
  };
  const sec = config.checkIntervalSeconds || defaultSec[skillKey] || 300;
  if (sec >= 3600 && sec % 3600 === 0) {
    result.intervalValue = sec / 3600;
    result.intervalUnitHour = true;
    result.intervalUnitMin = false;
    result.intervalUnitSec = false;
  } else if (sec >= 60 && sec % 60 === 0) {
    result.intervalValue = sec / 60;
    result.intervalUnitMin = true;
    result.intervalUnitHour = false;
    result.intervalUnitSec = false;
  } else {
    result.intervalValue = sec;
    result.intervalUnitSec = true;
    result.intervalUnitMin = false;
    result.intervalUnitHour = false;
  }

  // Numeric defaults
  result.checkIntervalSeconds = config.checkIntervalSeconds || 300;
  result.anomalyThreshold = config.anomalyThreshold || 3;
  result.maxLogLines = config.maxLogLines || 200;
  result.diskThresholdPercent = config.diskThresholdPercent || 80;
  return result;
};

/** Builds a config object from form data, skill-specific. */
const buildConfig = (skillKey, form) => {
  const base = {};
  // Common: check interval — parse value + unit, store as seconds
  // Per-skill defaults: package-updater=168h, storage-maid=24h, optimizer=24h,
  // sus-finder=1h, error-finder=2h, uptime-police=15m, others=5m
  const defaultIntervalSec = {
    "package-updater": 604800, "storage-maid": 86400, "optimizer": 86400,
    "sus-finder": 3600, "error-finder": 7200, "uptime-police": 900,
  };
  const formatted = String(form.intervalValue || "").trim();
  let intervalVal;
  if (formatted) {
    intervalVal = parseInt(formatted);
  } else {
    // No form value — set default for this skill
    intervalVal = defaultIntervalSec[skillKey] || 300;
    base.checkIntervalSeconds = intervalVal;
    // Skip the multiplier calculation below since we already set seconds directly
  }
  if (!base.checkIntervalSeconds) {
    const intervalUnit = form.intervalUnit || "min";
    const multipliers = { sec: 1, min: 60, hour: 3600 };
    base.checkIntervalSeconds = (intervalVal || 5) * (multipliers[intervalUnit] || 60);
  }
  if (skillKey === "storage-maid") {
    base.intensity = form.intensity === "moderate" ? "moderate" : "safe";
    base.cleanDepth = form.cleanDepth === "standard" || form.cleanDepth === "deep" ? form.cleanDepth : "light";
    base.excludeDirs = String(form.excludeDirs || "").split("\n").map((s) => s.trim()).filter(Boolean);
    base.diskThresholdPercent = parseInt(form.diskThresholdPercent) || 80;
  }
  if (skillKey === "uptime-police") {
    base.monitoredServices = String(form.monitoredServices || "").split("\n").map((s) => s.trim()).filter(Boolean);
    base.anomalyThreshold = parseInt(form.anomalyThreshold) || 3;
    base.autoRestart = form.autoRestart === "1";
  }
  if (skillKey === "error-finder") {
    base.logSources = String(form.logSources || "").split("\n").map((s) => s.trim()).filter(Boolean);
    base.ignorePatterns = String(form.ignorePatterns || "").split("\n").map((s) => s.trim()).filter(Boolean);
    base.maxLogLines = parseInt(form.maxLogLines) || 200;
  }
  if (skillKey === "package-updater") {
    base.ignoredPackages = String(form.ignoredPackages || "").split("\n").map((s) => s.trim()).filter(Boolean);
    base.dryRunOnly = form.dryRunOnly === "1";
  }
  if (skillKey === "optimizer") {
    const raw = Array.isArray(form.categories) ? form.categories : form.categories ? [form.categories] : [];
    base.categories = raw.filter(Boolean);
    base.minRiskLevel = form.minRiskLevel === "medium" ? "medium" : "low";
  }
  if (skillKey === "sus-finder") {
    base.checkAuthLog = form.checkAuthLog === "1";
    base.checkProcesses = form.checkProcesses === "1";
    base.checkPorts = form.checkPorts === "1";
    base.checkCrontabs = form.checkCrontabs === "1";
    base.checkFailedLogins = form.checkFailedLogins === "1";
    base.maxAuthLogLines = parseInt(form.maxAuthLogLines) || 300;
    base.maxFailedLogins = parseInt(form.maxFailedLogins) || 50;
    base.ignorePatterns = String(form.ignorePatterns || "").split("\n").map((s) => s.trim()).filter(Boolean);
  }
  return base;
};

/** Accumulates token usage from one API call into the token_usage log table. */
const accumulateUsage = async (usage, options = {}) => {
  if (!usage || !usage.totalTokens) return;
  await models.TokenUsage.create({
    skillKey: options.skillKey || "",
    model: options.model || "",
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    totalTokens: usage.totalTokens || 0,
    source: options.source || "chat",
    createdAt: new Date(),
  });
};

/** Creates a safe SVG progress ring used on the primary host metric cards. */
const progressRing = (value, label) => {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const circumference = 2 * Math.PI * 18;
  const offset = circumference * (1 - percent / 100);
  return `<svg class="progress-ring" viewBox="0 0 44 44" role="img" aria-label="${label} ${formatPercent(value)}"><circle class="progress-ring-track" cx="22" cy="22" r="18"/><circle class="progress-ring-value" cx="22" cy="22" r="18" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/></svg>`;
};

/** Builds human-readable rolling averages from report history. */
const rollingLabels = (history, field, formatter = formatPercent) => ({
  average5m: formatter(rollingAverage(history, field, 5 * 60 * 1000)),
  average30m: formatter(rollingAverage(history, field, 30 * 60 * 1000)),
  average6h: formatter(rollingAverage(history, field, 6 * 60 * 60 * 1000)),
});

/** Maps domain status text to Bootstrap-compatible visual emphasis. */
const statusClass = (status) => {
  if (["online", "up", "operational"].includes(status)) return "success";
  if (["stale", "slow", "detected", "degraded"].includes(status)) return "warning";
  if (["offline", "down", "unavailable"].includes(status)) return "danger";
  return "secondary";
};

/** Derives online, stale, or offline solely from the last accepted agent report. */
const serverState = (lastSeenAt) => {
  if (!lastSeenAt) return "offline";
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < 90_000) return "online";
  if (age <= 180_000) return "stale";
  return "offline";
};

/** Ensures numeric form values stay inside a documented operational range. */
const integerInRange = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

/** Builds pagination state for Mustache templates (prev/next, page numbers, active flags). */
const paginationMeta = (page, totalPages, query) => {
  const isFirst = page === 1, isLast = page === totalPages;
  const maxPages = 7; // Show at most 7 page links
  let startPage = Math.max(1, page - 3);
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  startPage = Math.max(1, endPage - maxPages + 1);
  const pages = [];
  for (let i = startPage; i <= endPage; i++) pages.push({ num: i, active: i === page });
  return {
    showPagination: totalPages > 1, prevPage: page - 1, nextPage: page + 1,
    isFirst, isLast, pages, query,
  };
};

/** Validates an HTTP monitoring URL and strips embedded credentials and fragments. */
const normalizeHttpUrl = (value) => {
  const url = new URL(String(value || "").trim());
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Credentials are not allowed inside monitoring URLs.");
  url.hash = "";
  return url.toString();
};

/** Increments the agent configuration version after any monitoring-target change. */
const touchAgentConfig = async (transaction) => {
  await models.Agent.increment("lastConfigVersion", { by: 1, where: { agentKey: "main-agent" }, transaction });
};

/** Loads latest service rows with their most recent immutable status sample, optionally filtered by server id. */
const loadServices = async (options = {}) => {
  const replacements = {};
  let whereClause = "";
  if (options.serverId) {
    whereClause = "WHERE service.server_id = :serverId";
    replacements.serverId = options.serverId;
  }
  return sequelize.query(`
    SELECT service.*, status.status, status.evidence, status.description,
           status.response_time_ms AS responseTimeMs, status.observed_at AS observedAt,
           agent.last_seen_at AS agentLastSeenAt
    FROM server_services service
    LEFT JOIN agents agent ON agent.server_id = service.server_id
    LEFT JOIN server_service_statuses status ON status.id = (
      SELECT inner_status.id FROM server_service_statuses inner_status
      WHERE inner_status.server_service_id = service.id
      ORDER BY inner_status.observed_at DESC LIMIT 1
    )
    ${whereClause}
    ORDER BY service.id
  `, { type: QueryTypes.SELECT, replacements });
};

/** Loads active or deleted applications with tags and their latest status. */
const loadApplications = async (includeDeleted = false) => sequelize.query(`
  SELECT application.*, status.status, status.status_code AS statusCode,
         status.response_time_ms AS responseTimeMs, status.observed_at AS observedAt,
         GROUP_CONCAT(tag.name, ', ') AS tagNames, agent.last_seen_at AS agentLastSeenAt
  FROM applications application
  LEFT JOIN agents agent ON agent.server_id = application.server_id
  LEFT JOIN application_statuses status ON status.id = (
    SELECT inner_status.id FROM application_statuses inner_status
    WHERE inner_status.application_id = application.id
    ORDER BY inner_status.observed_at DESC LIMIT 1
  )
  LEFT JOIN application_tag_assignments assignment ON assignment.application_id = application.id
  LEFT JOIN application_tags tag ON tag.id = assignment.application_tag_id
  ${includeDeleted ? "" : "WHERE application.deleted_at IS NULL"}
  GROUP BY application.id
  ORDER BY application.display_name COLLATE NOCASE
`, { type: QueryTypes.SELECT });

/** Shapes rows for Mustache without relying on template-side calculations. */
const decorateStatuses = (rows) => rows.map((row) => {
  // Current positive evidence becomes unknown when its producing agent is no
  // longer online; immutable historical rows retain their recorded status.
  const hasFreshness = Object.hasOwn(row, "agentLastSeenAt");
  const staleEvidence = hasFreshness && serverState(row.agentLastSeenAt) !== "online";
  const isDeleted = Boolean(row.deleted_at || row.deletedAt);
  const status = isDeleted ? "deleted" : staleEvidence ? "unknown" : row.status || "unknown";
  return {
    ...row, status, statusClass: statusClass(status),
    evidence: staleEvidence ? "stale agent" : row.evidence,
    responseTimeLabel: row.responseTimeMs == null ? "—" : `${row.responseTimeMs} ms`,
    observedAtLabel: row.observedAt ? new Date(row.observedAt).toLocaleString() : "Never",
    isDeleted,
    enabledLabel: row.enabled ? "Enabled" : "Disabled",
    disabled: !row.enabled,
    serviceIcon: serviceRegistry.get(row.type)?.icon || "fa-solid fa-server",
  };
});

/** Loads tag choices and marks assignments for application forms. */
const tagChoices = async (applicationId = null) => {
  const tags = await models.ApplicationTag.findAll({ order: [["name", "ASC"]] });
  const assignments = applicationId
    ? await models.ApplicationTagAssignment.findAll({ where: { applicationId } })
    : [];
  const selected = new Set(assignments.map((assignment) => assignment.applicationTagId));
  return tags.map((tag) => ({ id: tag.id, name: tag.name, selected: selected.has(tag.id) }));
};

/** Replaces tag assignments from Tagify or the comma-separated no-JavaScript fallback. */
const saveApplicationTags = async (applicationId, form, transaction) => {
  const selectedIds = [];
  for (const value of Array.isArray(form.tagIds) ? form.tagIds : form.tagIds ? [form.tagIds] : []) {
    const id = Number(value);
    if (Number.isInteger(id)) selectedIds.push(id);
  }
  let requestedNames = [];
  const input = String(form.tagNames || form.newTags || "").trim();
  try {
    const parsed = JSON.parse(input);
    requestedNames = Array.isArray(parsed) ? parsed.map((item) => typeof item === "object" ? item.value : item) : [];
  } catch { requestedNames = input.split(","); }
  const inlineNames = Array.from(new Set(requestedNames.map((name) => String(name).trim()).filter(Boolean).map((name) => name.toLowerCase())));
  if (inlineNames.length + selectedIds.length > 10) throw new Error("An application may have at most 10 tags.");
  for (const name of inlineNames) {
    if (name.length > 50) throw new Error("Tag names may contain at most 50 characters.");
    const [tag] = await models.ApplicationTag.findOrCreate({
      where: { name }, defaults: { name }, transaction,
    });
    selectedIds.push(tag.id);
  }
  const uniqueIds = Array.from(new Set(selectedIds)).slice(0, 10);
  await models.ApplicationTagAssignment.destroy({ where: { applicationId }, transaction });
  if (uniqueIds.length) {
    await models.ApplicationTagAssignment.bulkCreate(
      uniqueIds.map((applicationTagId) => ({ applicationId, applicationTagId })),
      { transaction },
    );
  }
};

router.get("/login", async (context) => {
  if (await resolveSession(context)) return context.redirect("/dashboard");
  return renderPage(context, "login", { error: context.req.query("error") }, { title: "Login — Symbio" });
});

router.post("/login", async (context) => {
  const form = await context.req.parseBody();
  const address = requestAddress(context);
  if (!loginAllowed(address)) return context.redirect("/login?error=Too+many+attempts.+Try+again+later.");
  const username = String(form.username || "").trim();
  const user = await models.User.findOne({ where: { [Op.or]: [{ username }, { email: username }] } });
  if (!user || !(await verifyPassword(user.passwordHash, String(form.password || "")))) {
    recordLoginFailure(address);
    return context.redirect("/login?error=Invalid+username+or+password.");
  }
  clearLoginFailures(address);
  await createSession(context, user.id);
  return context.redirect("/dashboard");
});

const protectedRoutes = new Hono();
protectedRoutes.use("*", requireAuth);

protectedRoutes.get("/", (context) => context.redirect("/dashboard"));

protectedRoutes.post("/logout", requireCsrf, async (context) => {
  await destroySession(context);
  return context.redirect("/login");
});

protectedRoutes.get("/dashboard", async (context) => {
  // Redirect superadmin to setup wizard if not completed
  if (isSuperadmin(context)) {
    const wizState = await readWizardState();
    if (!wizState.completed) return context.redirect("/setup-wizard");
  }
  const sixHours = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const [server, agent, latestStatus, history, services, applications, llmRow, skills, tokenUsage] = await Promise.all([
    models.Server.findOne({ where: { slug: "main-server" } }),
    models.Agent.findOne({ where: { agentKey: "main-agent" } }),
    models.ServerStatus.findOne({ order: [["observedAt", "DESC"]] }),
    models.ServerStatus.findAll({ where: { observedAt: { [Op.gte]: sixHours } }, raw: true }),
    loadServices(), loadApplications(),
    models.Setting.findByPk("llm_config"),
    models.Skill.findAll({ raw: true }),
    readLlmUsage(),
  ]);
  const state = serverState(agent?.lastSeenAt);
  const decoratedServices = decorateStatuses(services);
  const decoratedApplications = decorateStatuses(applications);
  const sixHourRange = { key: "6h", label: "6 hours", milliseconds: 6 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };

  // AI Summarizer — cached in settings, regenerates daily (or TTL)
  let llmConfig = null;
  try { if (llmRow) llmConfig = JSON.parse(llmRow.value); } catch {}
  const modelName = llmConfig?.model || "—";
  const modelNameShort = modelName.length > 18 ? modelName.slice(0, 15) + "..." : modelName;
  let summarizerContent = null;
  try {
    const summaryRow = await models.Setting.findByPk("dashboard_summary");
    const ttlRow = await models.Setting.findByPk("dashboard_summary_ttl");
    const ttl = ttlRow ? (parseInt(ttlRow.value) || 86400) : 86400;
    if (summaryRow) {
      const cached = JSON.parse(summaryRow.value);
      if (cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime()) < ttl * 1000) {
        summarizerContent = cached.contentHtml;
      }
    }
    if (!summarizerContent && llmConfig) {
      const { askAI } = await import("../services/llm.service.js");
      const pendingCount = await models.SkillAction.count({ where: { status: "pending" } });
      const contextStr = [
        `CPU: ${latestStatus?.cpuPercent || "?"}%`,
        `RAM: ${latestStatus?.memoryPercent || "?"}% (${Math.round(latestStatus?.memoryUsedBytes / 1073741824)}GB / ${Math.round(latestStatus?.memoryTotalBytes / 1073741824)}GB)`,
        `Disk: ${latestStatus?.diskPercent || "?"}%`,
        `Server state: ${state}`,
        `Services: ${decoratedServices.length} total, ${decoratedServices.filter(s => s.status !== "operational").length} non-operational`,
        `Applications: ${decoratedApplications.length} deployed`,
        `Pending actions: ${pendingCount}`,
        `Skills: ${skills.length} total, ${skills.filter(s => s.enabled).length} enabled`,
      ].join("\n");
      const result = await askAI({
        provider: llmConfig.provider, apiKey: llmConfig.apiKey || llmConfig.secretKey,
        endpoint: llmConfig.endpoint, model: llmConfig.model,
        logContent: contextStr,
        language: llmConfig.language, personality: llmConfig.personality,
        customInstruction: llmConfig.customInstruction,
        question: "Write a short server health summary as a single paragraph (2-3 sentences, no headings). Mention any warnings or pending actions. Add one practical maintenance tip. Be concise.",
      });
      if (result.content) {
        const contentHtml = renderMarkdown(result.content);
        await models.Setting.upsert({
          key: "dashboard_summary",
          value: JSON.stringify({ content: result.content, contentHtml, generatedAt: new Date().toISOString() }),
          updatedAt: new Date(),
        });
        summarizerContent = contentHtml;
        if (result.usage) await accumulateUsage(result.usage, { model: llmConfig.model, source: "summarizer" });
      }
    }
  } catch {}

  // Command Center wrap-up data: count enabled skills and running tasks
  const enabledSkillCount = skills.filter(s => s.enabled).length;
  let wrapRunningTasks = 0;
  try {
    const { getRunningTasks } = await import("../services/skills/scheduler.js");
    wrapRunningTasks = getRunningTasks().length;
  } catch {}
  // Token usage wrap-up
  const wrapTokensTotal = tokenUsage.totalTokens || 0;
  const wrapTokenCalls = tokenUsage.requestCount || 0;
  // Model logo
  const wrapModelLogo = modelLogo(modelName);
  const pendingActionCount = await models.SkillAction.count({ where: { status: "pending" } }).catch(() => 0);

  // Load firing alert events for the dashboard banner
  const firingAlertEvents = await sequelize.query(`
    SELECT ae.*, ar.name as rule_name, ar.resource, ar.metric_field, ar.operator, ar.severity
    FROM alert_events ae
    JOIN alert_rules ar ON ae.rule_id = ar.id
    WHERE ae.status = 'firing'
    ORDER BY ae.triggered_at DESC
    LIMIT 10
  `, { type: QueryTypes.SELECT }).catch(() => []);
  const firingAlertsDecorated = firingAlertEvents.map((e, i) => ({
    ruleName: e.rule_name,
    resourceLabel: alertResourceLabel(e.resource, e.metric_field),
    metricDisplay: formatMetricDisplay(e.metric_field, e.metric_value),
    thresholdDisplay: formatMetricDisplay(e.metric_field, e.threshold_value),
    operatorLabel: e.operator === "gt" ? ">" : "<",
    triggeredAt: e.triggered_at ? new Date(e.triggered_at).toLocaleString() : "—",
    severityClass: severityClass(e.severity),
    severityLabel: e.severity || "warning",
    last: i === firingAlertEvents.length - 1,
  }));

  return renderPage(context, "dashboard", {
    firingAlerts: firingAlertsDecorated,
    server: server?.toJSON(), state, stateClass: statusClass(state),
    serverOnline: state === "online", serverOffline: state !== "online",
    lastSeenAt: agent?.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "Never",
    cpuPercent: formatPercent(latestStatus?.cpuPercent), memoryPercent: formatPercent(latestStatus?.memoryPercent), diskPercent: formatPercent(latestStatus?.diskPercent),
    memoryAmount: `${formatBytes(latestStatus?.memoryUsedBytes)} / ${formatBytes(latestStatus?.memoryTotalBytes)}`,
    diskAmount: `${formatBytes(latestStatus?.diskUsedBytes)} / ${formatBytes(latestStatus?.diskTotalBytes)}`,
    cpuRing: progressRing(latestStatus?.cpuPercent, "CPU usage"), memoryRing: progressRing(latestStatus?.memoryPercent, "Memory usage"), diskRing: progressRing(latestStatus?.diskPercent, "Disk usage"),
    cpuAverages: rollingLabels(history, "cpuPercent"), memoryAverages: rollingLabels(history, "memoryPercent"),
    services: decoratedServices.slice(0, 5), applications: decoratedApplications.slice(0, 5),
    serviceOperational: decoratedServices.filter((item) => item.status === "operational").length,
    applicationUp: decoratedApplications.filter((item) => item.status === "up").length,
    applicationTotal: decoratedApplications.length,
    cpuChart: renderLineChart([{ name: "CPU average", points: bucketSeries(history, "cpuPercent", sixHourRange) }], "CPU usage (last 6 hours)", "%"),
    memoryChart: renderLineChart([{ name: "Memory", points: bucketSeries(history, "memoryPercent", sixHourRange) }], "Memory usage (last 6 hours)", "%"),
    diskChart: renderLineChart([{ name: "Root disk", points: bucketSeries(history, "diskPercent", sixHourRange) }], "Disk usage (last 6 hours)", "%"),
    // AI Summarizer
    summarizerContent,
    pendingActionCount,
    // Command Center wrap-up
    wrapSkillsRunning: enabledSkillCount,
    wrapSkillsIdle: 0,
    wrapRunningTasks,
    wrapModelName: modelNameShort,
    wrapModelLogo,
    wrapTokensTotal: wrapTokensTotal.toLocaleString(),
    wrapTokenCalls,
  }, { title: "Dashboard — Symbio" });
});

protectedRoutes.get("/servers", async (context) => {
  const server = await models.Server.findOne({ where: { slug: "main-server" } });
  const [agent, latest] = await Promise.all([models.Agent.findOne({ where: { serverId: server.id } }), models.ServerStatus.findOne({ where: { serverId: server.id }, order: [["observedAt", "DESC"]] })]);
  const state = serverState(agent?.lastSeenAt);
  return renderPage(context, "servers-list", {
    servers: [{ ...server.toJSON(), state, stateClass: statusClass(state), lastSeenAt: agent?.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "Never", cpuDisplay: formatPercent(latest?.cpuPercent), memoryDisplay: formatPercent(latest?.memoryPercent), diskDisplay: formatPercent(latest?.diskPercent) }],
  }, { title: "Servers — Symbio" });
});

protectedRoutes.get("/servers/:id", async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const [agent, latest, rollingHistory] = await Promise.all([
    models.Agent.findOne({ where: { serverId: server.id } }),
    models.ServerStatus.findOne({ where: { serverId: server.id }, order: [["observedAt", "DESC"]] }),
    models.ServerStatus.findAll({ where: { serverId: server.id, observedAt: { [Op.gte]: new Date(Date.now() - 6 * 60 * 60 * 1000) } }, raw: true }),
  ]);
  const state = serverState(agent?.lastSeenAt);
  // Parse inventory JSON once; the detail page and each dedicated sub-page share the same storage/network arrays.
  const storage = parseArray(server.storageJson);
  const networking = parseArray(server.networkJson);
  const services = decorateStatuses(await loadServices({ serverId: server.id }));
  return renderPage(context, "server-detail", {
    server: {
      ...server.toJSON(), hardware: parseJson(server.hardwareJson, {}),
      storage: storage.map((entry) => ({ ...entry, usedLabel: formatBytes(entry.usedBytes), totalLabel: formatBytes(entry.totalBytes), usePercent: entry.totalBytes > 0 ? Math.round((entry.usedBytes / entry.totalBytes) * 100) : 0 })),
      networking: networking.filter((entry) => entry.state === "up").map((entry) => ({ ...entry, addressList: (entry.addresses || []).map((addr) => addr.address).join(", ") })),
    }, state, stateClass: statusClass(state),
    lastSeenAt: agent?.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "Never",
    latest: latest ? {
      ...latest.toJSON(),
      cpuDisplay: formatPercent(latest.cpuPercent), memoryDisplay: formatPercent(latest.memoryPercent), diskDisplay: formatPercent(latest.diskPercent),
      cpuRing: progressRing(latest.cpuPercent, "CPU usage"), memoryRing: progressRing(latest.memoryPercent, "Memory usage"), diskRing: progressRing(latest.diskPercent, "Disk usage"),
      loadLabel: [latest.load1, latest.load5, latest.load15].map((value) => value == null ? "—" : Number(value).toFixed(2)).join(" / "),
      uptimeLabel: formatUptime(latest.uptimeSeconds),
      memoryUsed: formatBytes(latest.memoryUsedBytes), memoryAvailable: formatBytes(latest.memoryAvailableBytes), memoryTotal: formatBytes(latest.memoryTotalBytes), swapUsed: formatBytes(latest.swapUsedBytes), swapTotal: formatBytes(latest.swapTotalBytes),
      diskUsed: formatBytes(latest.diskUsedBytes), diskTotal: formatBytes(latest.diskTotalBytes),
      cpuCores: parseArray(latest.cpuCoresJson).map((core) => ({ ...core, coreLabel: core.id.replace(/^cpu/i, "CPU "), percentDisplay: formatPercent(core.percent) })),
      cpuAverages: rollingLabels(rollingHistory, "cpuPercent"), memoryAverages: rollingLabels(rollingHistory, "memoryPercent"),
    } : null,
    services,
  }, { title: `${server.displayName} — Symbio` });
});

// ---- Dedicated Server Sub-Pages ----

/** Helper that resolves a server by id and returns the parsed inventory arrays used by all sub-pages. */
const resolveServer = async (serverId) => {
  const server = await models.Server.findByPk(serverId);
  if (!server) return null;
  return { ...server.toJSON(), hardware: parseJson(server.hardwareJson, {}), storage: parseArray(server.storageJson), networking: parseArray(server.networkJson) };
};

protectedRoutes.get("/servers/:id/resource-charts", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const range = chartRange(context.req.query("range"));
  const since = new Date(Date.now() - range.milliseconds);
  const history = await models.ServerStatus.findAll({ where: { serverId: server.id, observedAt: { [Op.gte]: since } }, order: [["observedAt", "ASC"]], raw: true });
  // Fix the Y-axis max to total capacity so the chart shows actual proportion of usage
  const memoryMaxGB = history.length ? ((history[0].memoryTotalBytes || 1) / (1024 * 1024 * 1024)) : 1;
  const diskMaxGB = history.length ? ((history[0].diskTotalBytes || 1) / (1024 * 1024 * 1024)) : 1;
  return renderPage(context, "server-resource-charts", {
    server, range,
    cpuChart: renderLineChart([{ name: "CPU average", points: bucketSeries(history, "cpuPercent", range) }, ...Array.from(new Set(history.flatMap((row) => parseArray(row.cpuCoresJson).map((core) => core.id)))).map((id) => ({ name: id, points: bucketSeries(history.map((row) => ({ observedAt: row.observedAt, value: parseArray(row.cpuCoresJson).find((core) => core.id === id)?.percent })), "value", range) }))], "CPU usage", "%"),
    memoryChart: renderLineChart([{ name: "Memory", points: bucketSeries(history.map((row) => ({ observedAt: row.observedAt, value: (row.memoryUsedBytes || 0) / (1024 * 1024 * 1024) })), "value", range) }], "Memory usage", " GB", { max: memoryMaxGB }),
    diskChart: renderLineChart([{ name: "Root storage", points: bucketSeries(history.map((row) => ({ observedAt: row.observedAt, value: (row.diskUsedBytes || 0) / (1024 * 1024 * 1024) })), "value", range) }], "Disk usage", " GB", { max: diskMaxGB }),
  }, { title: "Resource Usage Charts — Symbio" });
});

protectedRoutes.get("/servers/:id/recent-data", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const recent = await models.ServerStatus.findAll({ where: { serverId: server.id }, order: [["observedAt", "DESC"]], limit: 50, raw: true });
  return renderPage(context, "server-recent-data", {
    server,
    recent: recent.map((row) => ({
      ...row, observedAtLabel: new Date(row.observedAt).toLocaleString(),
      cpuDisplay: formatPercent(row.cpuPercent), memoryDisplay: `${formatBytes(row.memoryUsedBytes)} (${formatPercent(row.memoryPercent)})`, diskDisplay: `${formatBytes(row.diskUsedBytes)} (${formatPercent(row.diskPercent)})`,
      cpuCores: parseArray(row.cpuCoresJson).map((core) => `${core.id}: ${formatPercent(core.percent)}`).join(", ") || "—",
    })),
  }, { title: "Agent Recent Data — Symbio" });
});

/** Lists all application log sources registered for this server, grouped by application. */
protectedRoutes.get("/servers/:id/monitoring/logs", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const logs = await sequelize.query(`
    SELECT l.id, l.display_name, l.file_path, l.tail_lines,
           a.id AS application_id, a.display_name AS application_display_name,
           a.deleted_at IS NOT NULL AS application_deleted
    FROM application_logs l
    JOIN applications a ON a.id = l.application_id
    WHERE a.server_id = ?
    ORDER BY a.display_name COLLATE NOCASE, l.display_name COLLATE NOCASE
  `, { type: QueryTypes.SELECT, replacements: [server.id] });
  return renderPage(context, "server-log-list", {
    server,
    logs: logs.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      filePath: row.file_path,
      tailLines: row.tail_lines,
      applicationId: row.application_id,
      applicationDisplayName: row.application_display_name,
      applicationDeleted: Boolean(row.application_deleted),
    })),
  }, { title: "Application Logs — Symbio" });
});

// ---- Predefined log source registries (mirrors agent-side whitelist) ----

const SERVER_LOG_SOURCES = [
  { slug: "syslog", displayName: "System Log", path: "/var/log/syslog" },
  { slug: "auth", displayName: "Authentication Log", path: "/var/log/auth.log" },
  { slug: "kern", displayName: "Kernel Log", path: "/var/log/kern.log" },
  { slug: "dmesg", displayName: "Kernel Ring Buffer", path: "/var/log/dmesg" },
  { slug: "boot", displayName: "Boot Log", path: "/var/log/boot.log" },
  { slug: "dpkg", displayName: "Package Manager Log", path: "/var/log/dpkg.log" },
];

const SERVICE_LOG_SOURCES = [
  { slug: "docker", displayName: "Docker Daemon", path: "/var/log/docker.log" },
  { slug: "mysql-error", displayName: "MySQL Error Log", path: "/var/log/mysql/error.log" },
  { slug: "postgresql-14", displayName: "PostgreSQL 14", path: "/var/log/postgresql/postgresql-14-main.log" },
  { slug: "postgresql-15", displayName: "PostgreSQL 15", path: "/var/log/postgresql/postgresql-15-main.log" },
  { slug: "postgresql-16", displayName: "PostgreSQL 16", path: "/var/log/postgresql/postgresql-16-main.log" },
  { slug: "redis", displayName: "Redis Server", path: "/var/log/redis/redis-server.log" },
  { slug: "nginx-access", displayName: "Nginx Access Log", path: "/var/log/nginx/access.log" },
  { slug: "nginx-error", displayName: "Nginx Error Log", path: "/var/log/nginx/error.log" },
  { slug: "apache-access", displayName: "Apache Access Log", path: "/var/log/apache2/access.log" },
  { slug: "apache-error", displayName: "Apache Error Log", path: "/var/log/apache2/error.log" },
];

const SYMBIO_LOG_SOURCES = [
  { slug: "mothership", displayName: "Mothership", description: "Symbio mothership dashboard logs" },
  { slug: "agent", displayName: "Agent", description: "Symbio host agent logs" },
];

const TAIL_OPTIONS = [50, 100, 200, 500, 1000];

/** Renders the server log viewer using a category-agnostic template. */
const renderLogViewer = (context, server, sourceDef, category, listTitle, contentUrl, searchUrl, limit, error, aiNotConfigured) => renderPage(context, "server-log-viewer", {
  server,
  log: { slug: sourceDef.slug, displayName: sourceDef.displayName, path: sourceDef.path || "" },
  category, listTitle, contentUrl, searchUrl,
  tailChoices: TAIL_OPTIONS.map((value) => ({ value, selected: value === (Number(limit) || 100) })),
  tailLimit: Number(limit) || 100,
  logContent: "", bytes: 0, truncated: false, error: error || "",
  lastReadAt: error ? "Not read" : new Date().toLocaleString(),
  aiNotConfigured,
}, { title: `${sourceDef.displayName} — ${listTitle} — Symbio` });

/** Server Logs list page. */
protectedRoutes.get("/servers/:id/monitoring/logs/server", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  return renderPage(context, "server-system-log-list", { server, sources: SERVER_LOG_SOURCES },
    { title: "Server Logs — Symbio" });
});

/** Server Log view page (SSR renders initial content). */
protectedRoutes.get("/servers/:id/monitoring/logs/server/view", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const slug = context.req.query("source");
  const sourceDef = SERVER_LOG_SOURCES.find((s) => s.slug === slug);
  if (!sourceDef) return context.notFound();
  const limit = context.req.query("limit") || "100";
  const aiNotConfigured = !(await isLlmConfigured());
  let error = "";
  try {
    const result = await readSystemLog(slug, limit);
    return renderPage(context, "server-log-viewer", {
      server, log: { slug: sourceDef.slug, displayName: sourceDef.displayName, path: sourceDef.path },
      category: "server", listTitle: "Server Logs",
      contentUrl: `/servers/${server.id}/monitoring/logs/system/content?source=${slug}`,
      searchUrl: `/servers/${server.id}/monitoring/logs/system/search?source=${slug}`,
      tailChoices: TAIL_OPTIONS.map((value) => ({ value, selected: value === (Number(limit) || 100) })),
      tailLimit: Number(limit) || 100,
      logContent: result.text, bytes: result.bytes, truncated: result.truncated, error: "",
      lastReadAt: new Date().toLocaleString(), aiNotConfigured,
    }, { title: `${sourceDef.displayName} — Server Logs — Symbio` });
  } catch (caught) { error = caught.message; }
  return renderLogViewer(context, server, sourceDef, "server", "Server Logs",
    `/servers/${server.id}/monitoring/logs/system/content?source=${slug}`,
    `/servers/${server.id}/monitoring/logs/system/search?source=${slug}`, limit, error, aiNotConfigured);
});

/** Service Logs list page. */
protectedRoutes.get("/servers/:id/monitoring/logs/services", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  return renderPage(context, "server-service-log-list", { server, sources: SERVICE_LOG_SOURCES },
    { title: "Service Logs — Symbio" });
});

/** Service Log view page. */
protectedRoutes.get("/servers/:id/monitoring/logs/services/view", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const slug = context.req.query("source");
  const sourceDef = SERVICE_LOG_SOURCES.find((s) => s.slug === slug);
  if (!sourceDef) return context.notFound();
  const limit = context.req.query("limit") || "100";
  const aiNotConfigured = !(await isLlmConfigured());
  let error = "";
  try {
    const result = await readSystemLog(slug, limit);
    return renderPage(context, "server-log-viewer", {
      server, log: { slug: sourceDef.slug, displayName: sourceDef.displayName, path: sourceDef.path },
      category: "services", listTitle: "Service Logs",
      contentUrl: `/servers/${server.id}/monitoring/logs/system/content?source=${slug}`,
      searchUrl: `/servers/${server.id}/monitoring/logs/system/search?source=${slug}`,
      tailChoices: TAIL_OPTIONS.map((value) => ({ value, selected: value === (Number(limit) || 100) })),
      tailLimit: Number(limit) || 100,
      logContent: result.text, bytes: result.bytes, truncated: result.truncated, error: "",
      lastReadAt: new Date().toLocaleString(), aiNotConfigured,
    }, { title: `${sourceDef.displayName} — Service Logs — Symbio` });
  } catch (caught) { error = caught.message; }
  return renderLogViewer(context, server, sourceDef, "services", "Service Logs",
    `/servers/${server.id}/monitoring/logs/system/content?source=${slug}`,
    `/servers/${server.id}/monitoring/logs/system/search?source=${slug}`, limit, error, aiNotConfigured);
});

/** Shared JSON content endpoint for server + service log auto-refresh polling. */
protectedRoutes.get("/servers/:id/monitoring/logs/system/content", async (context) => {
  const slug = context.req.query("source");
  try {
    const result = await readSystemLog(slug, context.req.query("limit") || "100");
    return context.json({ ok: true, ...result, readAt: new Date().toISOString() });
  } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
});

/** Shared search endpoint for server + service logs. */
protectedRoutes.post("/servers/:id/monitoring/logs/system/search", requireCsrf, async (context) => {
  const slug = context.req.query("source");
  const query = String(context.get("form").query || "").trim();
  let result;
  let error = "";
  try { result = await searchSystemLog(slug, query); } catch (caught) { error = caught.message; }
  const sourceDef = [...SERVER_LOG_SOURCES, ...SERVICE_LOG_SOURCES].find((s) => s.slug === slug) || { displayName: slug };
  const category = SERVER_LOG_SOURCES.some((s) => s.slug === slug) ? "server" : "services";
  const listTitle = category === "server" ? "Server Logs" : "Service Logs";
  return renderPage(context, "server-log-search", {
    server: await resolveServer(context.req.param("id")),
    log: { slug, displayName: sourceDef.displayName }, category, listTitle,
    query, logContent: result?.text || "", bytes: result?.bytes || 0, truncated: result?.truncated, error,
  }, { title: `Search ${sourceDef.displayName} — ${listTitle} — Symbio` });
});

/** Symbio Logs list page. */
protectedRoutes.get("/servers/:id/monitoring/logs/symbio", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  return renderPage(context, "server-symbio-log-list", { server, sources: SYMBIO_LOG_SOURCES },
    { title: "Symbio Logs — Symbio" });
});

/** Symbio Log view page. */
protectedRoutes.get("/servers/:id/monitoring/logs/symbio/view", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  const slug = context.req.query("source");
  const sourceDef = SYMBIO_LOG_SOURCES.find((s) => s.slug === slug);
  if (!sourceDef) return context.notFound();
  const limit = context.req.query("limit") || "100";
  const contentUrl = `/servers/${server.id}/monitoring/logs/symbio/content?source=${slug}`;
  const searchUrl = `/servers/${server.id}/monitoring/logs/symbio/search?source=${slug}`;
  const aiNotConfigured = !(await isLlmConfigured());
  let result;
  let error = "";
  try {
    result = slug === "mothership" ? await readMothershipLog(limit) : await readAgentLog(limit);
    return renderPage(context, "server-log-viewer", {
      server, log: { slug: sourceDef.slug, displayName: sourceDef.displayName },
      category: "symbio", listTitle: "Symbio Logs", contentUrl, searchUrl,
      tailChoices: TAIL_OPTIONS.map((value) => ({ value, selected: value === (Number(limit) || 100) })),
      tailLimit: Number(limit) || 100,
      logContent: result.text, bytes: result.bytes, truncated: result.truncated, error: "",
      lastReadAt: new Date().toLocaleString(), aiNotConfigured,
    }, { title: `${sourceDef.displayName} — Symbio Logs — Symbio` });
  } catch (caught) { error = caught.message; }
  return renderLogViewer(context, server, sourceDef, "symbio", "Symbio Logs", contentUrl, searchUrl, limit, error, aiNotConfigured);
});

/** JSON content endpoint for Symbio log auto-refresh polling. */
protectedRoutes.get("/servers/:id/monitoring/logs/symbio/content", async (context) => {
  const slug = context.req.query("source");
  try {
    const result = slug === "mothership" ? await readMothershipLog(context.req.query("limit") || "100") : await readAgentLog(context.req.query("limit") || "100");
    return context.json({ ok: true, ...result, readAt: new Date().toISOString() });
  } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
});

/** Search endpoint for Symbio logs. */
protectedRoutes.post("/servers/:id/monitoring/logs/symbio/search", requireCsrf, async (context) => {
  const slug = context.req.query("source");
  const query = String(context.get("form").query || "").trim();
  let result;
  let error = "";
  try {
    result = slug === "mothership" ? await searchMothershipLog(query) : await searchAgentLog(query);
  } catch (caught) { error = caught.message; }
  const sourceDef = SYMBIO_LOG_SOURCES.find((s) => s.slug === slug) || { displayName: slug };
  return renderPage(context, "server-log-search", {
    server: await resolveServer(context.req.param("id")),
    log: { slug, displayName: sourceDef.displayName }, category: "symbio", listTitle: "Symbio Logs",
    query, logContent: result?.text || "", bytes: result?.bytes || 0, truncated: result?.truncated, error,
  }, { title: `Search ${sourceDef.displayName} — Symbio Logs — Symbio` });
});

protectedRoutes.get("/servers/:id/storage", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let diskIO = []; let ioError = "";
  try { const result = await fetchDiskIO(); diskIO = result.disks || []; } catch (caught) { ioError = caught.message; }
  return renderPage(context, "server-storage", {
    server,
    storage: server.storage.map((entry) => ({ ...entry, usedLabel: formatBytes(entry.usedBytes), totalLabel: formatBytes(entry.totalBytes), availableLabel: formatBytes(entry.availableBytes), usePercent: entry.totalBytes > 0 ? Math.round((entry.usedBytes / entry.totalBytes) * 100) : 0 })),
    diskIO: diskIO.map((d) => ({ ...d, readsLabel: d.reads.toLocaleString(), writesLabel: d.writes.toLocaleString(), ioTimeLabel: `${d.ioTime} ms` })), ioError,
  }, { title: "Storage — Symbio" });
});

protectedRoutes.get("/servers/:id/networking", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  return renderPage(context, "server-networking", {
    server,
    networking: server.networking.map((entry) => ({ ...entry, countersLabel: `${formatBytes(entry.rxBytes)} / ${formatBytes(entry.txBytes)}`, addressList: (entry.addresses || []).map((addr) => `${addr.family} ${addr.address}`).join(", ") })),
  }, { title: "Network Interfaces — Symbio" });
});

// ---- System inspection sub-pages (on-demand from agent) ----

protectedRoutes.get("/servers/:id/info", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let info = {}; let error = "";
  try { info = await fetchServerInfo(); } catch (caught) { error = caught.message; }
  return renderPage(context, "server-info", {
    server,
    info: { ...info, memory: { ...info.memory, totalLabel: formatBytes(info.memory?.total), swapLabel: formatBytes(info.memory?.swapTotal) }, cpu: info.cpu || {} },
    error,
  }, { title: "Server Information — Symbio" });
});

protectedRoutes.get("/servers/:id/processes", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let data = {}; let error = "";
  try { data = await fetchProcessList(); } catch (caught) { error = caught.message; }
  const query = String(context.req.query("q") || "").trim();
  const perPage = 50;
  const page = Math.max(1, parseInt(context.req.query("page"), 10) || 1);
  let items = (data.processes || []).map((p) => ({ ...p, rssLabel: formatBytes(p.rss), vsizeLabel: formatBytes(p.vsize), cpuLabel: `${(p.cpuTime / 100).toFixed(1)}s` }));
  if (query) { const q = query.toLowerCase(); items = items.filter((p) => String(p.command).toLowerCase().includes(q) || String(p.user).toLowerCase().includes(q) || String(p.pid).includes(q)); }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(page, totalPages);
  items = items.slice((p - 1) * perPage, p * perPage);
  return renderPage(context, "server-processes", {
    server, processes: items, total, error, query, page: p, totalPages, perPage,
    showing: { from: total ? (p - 1) * perPage + 1 : 0, to: Math.min(p * perPage, total) },
    ...paginationMeta(p, totalPages, query),
  }, { title: "Process List — Symbio" });
});

/** Kills a process on the server. Requires CSRF for security. */
protectedRoutes.post("/servers/:id/processes/kill", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const form = context.get("form");
  const pid = parseInt(String(form.pid), 10);
  const force = String(form.force) === "1";
  const query = String(form.q || "");
  const page = String(form.page || "1");
  const actionType = force ? "process.kill-force" : "process.kill";
  try {
    await executeSkillActions([{ action: actionType, params: { pid } }]);
    return context.redirect(`/servers/${server.id}/processes?page=${page}${query ? `&q=${encodeURIComponent(query)}` : ""}&killed=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/processes?page=${page}${query ? `&q=${encodeURIComponent(query)}` : ""}&error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.get("/servers/:id/ports", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let data = {}; let error = "";
  try { data = await fetchListeningPorts(); } catch (caught) { error = caught.message; }
  const query = String(context.req.query("q") || "").trim();
  const perPage = 50;
  const page = Math.max(1, parseInt(context.req.query("page"), 10) || 1);
  let items = data.ports || [];
  if (query) { const q = query.toLowerCase(); items = items.filter((p) => String(p.processName).toLowerCase().includes(q) || String(p.localPort).includes(q) || String(p.protocol).includes(q)); }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(page, totalPages);
  items = items.slice((p - 1) * perPage, p * perPage);
  return renderPage(context, "server-ports", {
    server, ports: items, total, error, query, page: p, totalPages, perPage,
    showing: { from: total ? (p - 1) * perPage + 1 : 0, to: Math.min(p * perPage, total) },
    ...paginationMeta(p, totalPages, query),
  }, { title: "Listening Ports — Symbio" });
});

protectedRoutes.get("/servers/:id/memory", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let data = {}; let error = "";
  try { data = await fetchMemoryDetail(); } catch (caught) { error = caught.message; }
  // Human-readable descriptions for common /proc/meminfo fields.
  const descriptions = {
    MemTotal: "Total usable physical RAM", MemFree: "RAM not in use by the kernel or applications", MemAvailable: "Estimated RAM available for new processes without swapping",
    Buffers: "Temporary storage for raw disk blocks", Cached: "In-memory page cache for filesystem reads",
    SwapCached: "Memory that was swapped out then back in but still in swap", Active: "Recently used memory, not easily reclaimed",
    Inactive: "Less recently used memory, eligible for reclamation", "Active(anon)": "Active anonymous memory (process heap/stack)",
    "Inactive(anon)": "Inactive anonymous memory", "Active(file)": "Active file-backed page cache",
    "Inactive(file)": "Inactive file-backed page cache", Unevictable: "Memory that cannot be swapped out (locked/shared)",
    Mlocked: "Memory locked via mlock()", SwapTotal: "Total swap space available", SwapFree: "Swap space not in use",
    Dirty: "Modified data waiting to be written to disk", Writeback: "Data actively being written to disk",
    AnonPages: "Anonymous pages in RAM (not file-backed)", Mapped: "Files mapped into process address space (mmap)",
    Shmem: "Shared memory and tmpfs usage", KReclaimable: "Kernel memory that can be reclaimed (includes SReclaimable)",
    Slab: "Kernel data structure cache total", SReclaimable: "Reclaimable slab (dentries, inodes)",
    SUnreclaim: "Non-reclaimable slab", KernelStack: "Kernel stack memory",
    PageTables: "Memory used by page table structures", NFS_Unstable: "NFS pages not yet committed to storage",
    Bounce: "Bounce buffers for older DMA devices", WritebackTmp: "FUSE temporary writeback buffers",
    CommitLimit: "Maximum memory that can be allocated (RAM + swap * overcommit ratio)", Committed_AS: "Total memory currently committed by processes",
    VmallocTotal: "Total virtual memory allocation space", VmallocUsed: "Virtual memory currently allocated",
    VmallocChunk: "Largest contiguous vmalloc block", Percpu: "Per-CPU memory allocations",
    HardwareCorrupted: "RAM flagged as corrupted by ECC", AnonHugePages: "Transparent huge pages for anonymous memory",
    ShmemHugePages: "Huge pages used by shmem/tmpfs", ShmemPmdMapped: "Shmem pages mapped at PMD level",
    FileHugePages: "Huge pages for file-backed memory", FilePmdMapped: "File-backed pages mapped at PMD level",
    HugePages_Total: "Pre-allocated hugepages total", HugePages_Free: "Pre-allocated hugepages available",
    HugePages_Rsvd: "Hugepages reserved by applications", HugePages_Surp: "Surplus hugepages above reservation",
    Hugepagesize: "Size of one hugepage", Hugetlb: "HugeTLB filesystem total",
    DirectMap4k: "Memory mapped with 4 KB page table entries", DirectMap2M: "Memory mapped with 2 MB page table entries",
    DirectMap1G: "Memory mapped with 1 GB page table entries",
  };
  return renderPage(context, "server-memory", {
    server, memory: data.memory || {},
    detail: (data.memory?.detail || []).map((d) => ({ ...d, label: formatBytes(d.value), description: descriptions[d.key] || "" })),
    error,
  }, { title: "Memory Detail — Symbio" });
});

protectedRoutes.get("/servers/:id/users", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let data = {}; let error = "";
  try { data = await fetchLoggedInUsers(); } catch (caught) { error = caught.message; }
  return renderPage(context, "server-users", {
    server, users: (data.users || []).map((u) => ({ ...u, loginLabel: u.loginTime ? new Date(u.loginTime).toLocaleString() : "—" })), error,
  }, { title: "Logged-in Users — Symbio" });
});

protectedRoutes.get("/servers/:id/packages", async (context) => {
  const server = await resolveServer(context.req.param("id"));
  if (!server) return context.notFound();
  let data = {}; let error = "";
  try { data = await fetchInstalledPackages(); } catch (caught) { error = caught.message; }
  const query = String(context.req.query("q") || "").trim();
  const perPage = 50;
  const page = Math.max(1, parseInt(context.req.query("page"), 10) || 1);
  let items = data.packages || [];
  if (query) { const q = query.toLowerCase(); items = items.filter((p) => String(p.name).toLowerCase().includes(q) || String(p.description || "").toLowerCase().includes(q)); }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(page, totalPages);
  items = items.slice((p - 1) * perPage, p * perPage);
  return renderPage(context, "server-packages", {
    server, packages: items, total, error, query, page: p, totalPages, perPage,
    showing: { from: total ? (p - 1) * perPage + 1 : 0, to: Math.min(p * perPage, total) },
    ...paginationMeta(p, totalPages, query),
  }, { title: "Installed Packages — Symbio" });
});

// ---- File Manager ----

/** Validates an absolute source directory path the same way log paths are vetted. */
const sourcePathValues = (form) => {
  const displayName = String(form.displayName || "").trim();
  const sourcePath = String(form.sourcePath || "").trim();
  if (!displayName || displayName.length > 120) throw new Error("Source name is required and may contain at most 120 characters.");
  if (!sourcePath.startsWith("/") || sourcePath.includes("\0") || sourcePath.split("/").includes("..") || sourcePath.length > 1024) throw new Error("Source path must be an absolute host path without traversal.");
  return { displayName, sourcePath };
};

/** Maps a raw agent file entry into the template's expected shape. */
const formatFileEntry = (entry, parentDir) => {
  const isDirectory = entry.type === "directory";
  const entryPath = parentDir === "/" ? `/${entry.name}` : `${parentDir}/${entry.name}`;
  let icon = '<i class="fa-solid fa-file-lines" aria-hidden="true"></i>';
  if (isDirectory) icon = '<i class="fa-solid fa-folder" aria-hidden="true"></i>';
  else if (entry.type === "symlink") icon = '<i class="fa-solid fa-link" aria-hidden="true"></i>';
  return {
    ...entry, path: entryPath, icon, isDirectory,
    sizeLabel: entry.type === "file" ? formatBytes(entry.size) : "—",
    modifiedLabel: entry.modified ? new Date(entry.modified).toLocaleString() : "—",
  };
};

protectedRoutes.get("/servers/:id/file-manager", async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const agent = await models.Agent.findOne({ where: { serverId: server.id } });
  const currentPath = context.req.query("path") || "/home";
  const showHidden = context.req.query("showHidden") === "1";
  let entries = [];
  let tree = [];
  let error = "";
  try {
    const dirResult = await listDirectory(currentPath, showHidden);
    entries = dirResult.entries.map((entry) => formatFileEntry(entry, dirResult.path));
    if (currentPath !== "/") {
      const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
      entries.unshift({ name: "..", path: parentPath, icon: '<i class="fa-solid fa-level-up-alt" aria-hidden="true"></i>', isDirectory: true, type: "directory", isUp: true, sizeLabel: "—", modifiedLabel: "—", permissions: "—" });
    }
    // Build the initial tree from top-level directories that correspond to
    // the agent's ALLOWED_ROOTS. Each node has hasChildren=true so the user
    // can expand it via the lazy-load tree AJAX endpoint.
    tree = [
      { name: "boot", path: "/boot", hasChildren: true },
      { name: "etc", path: "/etc", hasChildren: true },
      { name: "home", path: "/home", hasChildren: true },
      { name: "mnt", path: "/mnt", hasChildren: true },
      { name: "opt", path: "/opt", hasChildren: true },
      { name: "root", path: "/root", hasChildren: true },
      { name: "srv", path: "/srv", hasChildren: true },
      { name: "tmp", path: "/tmp", hasChildren: true },
      { name: "usr", path: "/usr", hasChildren: true },
      { name: "var", path: "/var", hasChildren: true },
    ];
  } catch (caught) { error = caught.message; }
  return renderPage(context, "file-manager", {
    server: server.toJSON(), currentPath, entries, tree, error, showHidden,
    state: serverState(agent?.lastSeenAt), stateClass: statusClass(serverState(agent?.lastSeenAt)),
  }, { title: "File Manager — Symbio" });
});

protectedRoutes.get("/servers/:id/file-manager/list", async (context) => {
  try {
    const dirPath = context.req.query("path") || "/";
    const showHidden = context.req.query("showHidden") === "1";
    const result = await listDirectory(dirPath, showHidden);
    return context.json({ ok: true, ...result });
  } catch (error) { return context.json({ ok: false, error: error.message }, 502); }
});

protectedRoutes.get("/servers/:id/file-manager/read", async (context) => {
  try {
    const filePath = context.req.query("path");
    if (!filePath) return context.json({ ok: false, error: "File path is required." }, 400);
    const maxBytes = Number(context.req.query("maxBytes")) || undefined;
    const result = await readFile(filePath, maxBytes);
    return context.json({ ok: true, ...result });
  } catch (error) { return context.json({ ok: false, error: error.message }, 502); }
});

protectedRoutes.get("/servers/:id/file-manager/tree", async (context) => {
  try {
    const dirPath = context.req.query("path") || "/";
    const result = await getDirectoryTree(dirPath);
    return context.json({ ok: true, ...result });
  } catch (error) { return context.json({ ok: false, error: error.message }, 502); }
});

protectedRoutes.get("/servers/:id/file-manager/view", async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const filePath = context.req.query("path");
  if (!filePath) return context.redirect(`/servers/${server.id}/file-manager`);
  let result = null; let error = "";
  try { result = await viewFile(filePath); } catch (caught) { error = caught.message; }
  const lines = result?.text ? result.text.split("\n").map((line, i) => ({ n: i + 1, text: line })) : [];
  const parentDir = filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") : "/";
  const fileName = filePath.split("/").pop() || filePath;
  return renderPage(context, "file-viewer", {
    server: server.toJSON(), filePath, parentDir, fileName, error, lines, lineCount: result?.lineCount || 0,
    fileSize: formatBytes(result?.fileSize || 0),
    truncated: result?.truncated || false, totalBytes: result?.bytes || 0,
  }, { title: `${fileName} — File Viewer — Symbio` });
});

// ── File Manager Write Operations ──

protectedRoutes.post("/servers/:id/file-manager/create", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const form = context.get("form");
  const currentPath = String(context.req.query("path") || form.path || "/");
  const name = String(form.name || "").trim();
  const type = String(form.type || "file");
  if (!name) return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&error=${encodeURIComponent("Name is required.")}`);
  try {
    await createEntry(currentPath, name, type);
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&created=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:id/file-manager/delete", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const form = context.get("form");
  const filePath = String(form.path || "");
  const parentDir = String(context.req.query("path") || "/");
  if (!filePath) return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(parentDir)}&error=${encodeURIComponent("Path is required.")}`);
  try {
    await deleteEntry(filePath);
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(parentDir)}&deleted=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(parentDir)}&error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:id/file-manager/rename", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const form = context.get("form");
  const fromPath = String(form.from || "");
  const toName = String(form.to || "").trim();
  const currentPath = String(context.req.query("path") || "/");
  if (!fromPath || !toName) return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&error=${encodeURIComponent("Source and new name are required.")}`);
  const toDir = fromPath.includes("/") ? fromPath.split("/").slice(0, -1).join("/") : "/";
  const toPath = toDir === "/" ? `/${toName}` : `${toDir}/${toName}`;
  try {
    await renameEntry(fromPath, toPath);
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&renamed=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:id/file-manager/chmod", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const form = context.get("form");
  const filePath = String(form.path || "");
  const mode = String(form.mode || "").trim();
  const currentPath = String(context.req.query("path") || "/");
  try {
    await changeMode(filePath, mode);
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&chmod=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(currentPath)}&error=${encodeURIComponent(caught.message)}`);
  }
});

// File Editor — GET renders file content in a textarea, POST saves it.
protectedRoutes.get("/servers/:id/file-manager/edit", async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const filePath = context.req.query("path");
  if (!filePath) return context.redirect(`/servers/${server.id}/file-manager`);
  let content = ""; let error = ""; let bytes = 0;
  try {
    const result = await viewFile(filePath);
    content = result.text || "";
    bytes = result.bytes || 0;
  } catch (caught) { error = caught.message; }
  // Read raw content via read endpoint too for editing (viewFile has 100KB limit but binary check)
  const fileName = filePath.split("/").pop() || filePath;
  const parentDir = filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") : "/";
  return renderPage(context, "server-file-editor", {
    server: server.toJSON(), filePath, fileName, parentDir, content, bytes, error,
    readOnly: !!error,
  }, { title: `Edit ${fileName} — Symbio` });
});

protectedRoutes.post("/servers/:id/file-manager/edit", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("id"));
  if (!server) return context.notFound();
  const body = await context.req.parseBody();
  const filePath = String(body.path || "");
  const content = String(body.content || "");
  const parentDir = filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") : "/";
  try {
    await writeFileService(filePath, content);
    return context.redirect(`/servers/${server.id}/file-manager?path=${encodeURIComponent(parentDir)}&saved=1`);
  } catch (caught) {
    const fileName = filePath.split("/").pop() || filePath;
    return renderPage(context, "server-file-editor", {
      server: server.toJSON(), filePath, fileName, parentDir, content, bytes: Buffer.byteLength(content, "utf8"),
      error: caught.message, readOnly: false,
    }, { title: `Edit ${fileName} — Symbio` });
  }
});

// ── Services — File View (existing) ──

protectedRoutes.get("/servers/:serverId/services", async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const services = decorateStatuses(await loadServices({ serverId: server.id })).map((s) => ({
    ...s,
    // Only nginx, apache, docker, pm2, redis support restart. MySQL/Postgres stay read-only.
    supportsRestart: ["nginx", "apache", "docker", "pm2", "redis"].includes(s.type),
  }));
  return renderPage(context, "services-list", {
    serverId: server.id, services,
  }, { title: "Services — Symbio" });
});

protectedRoutes.get("/servers/:serverId/services/:serviceId", async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.serverId !== server.id) return context.notFound();
  const range = chartRange(context.req.query("range"));
  const [statuses, agent] = await Promise.all([models.ServerServiceStatus.findAll({
    where: { serverServiceId: service.id, observedAt: { [Op.gte]: new Date(Date.now() - range.milliseconds) } },
    order: [["observedAt", "DESC"]], limit: 500, raw: true,
  }), models.Agent.findOne({ where: { serverId: service.serverId } })]);
  const latest = statuses[0] ? decorateStatuses([{ ...statuses[0], agentLastSeenAt: agent?.lastSeenAt || null }])[0] : null;
  const component = serviceRegistry.get(service.type);
  const template = component?.templates?.detail || "service-detail";
  let extraData = {};
  if (component?.fetchData) {
    try { extraData = await component.fetchData(); }
    catch (error) { extraData = { fetchError: error.message }; }
  }
  const tab = context.req.query("tab") || "containers";
  return renderPage(context, template, {
    service: { ...service.toJSON(), serviceIcon: component?.icon || "fa-solid fa-server" }, latest, range,
    recent: decorateStatuses(statuses.slice(0, 20)),
    ...extraData,
    containers: extraData.containers || [],
    volumes: extraData.volumes || [],
    networks: extraData.networks || [],
    fetchError: extraData.fetchError || "",
    containersError: extraData.containersError || "",
    volumesError: extraData.volumesError || "",
    networksError: extraData.networksError || "",
    tabContainers: tab === "containers",
    tabVolumes: tab === "volumes",
    tabNetworks: tab === "networks",
  }, { title: `${service.displayName} — Symbio` });
});

/** Renders a container detail page for Docker service components. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/docker/containers/:containerId", async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "docker" || service.serverId !== server.id) return context.notFound();
  const component = serviceRegistry.get("docker");
  const template = component?.templates?.containerDetail || "service-detail";
  const serviceJson = { ...service.toJSON(), serviceIcon: component?.icon || "fa-solid fa-server" };
  let container = null;
  let error = "";
  try {
    const { fetchDockerContainer } = await import("../services/docker.service.js");
    const result = await fetchDockerContainer(context.req.param("containerId"));
    container = result.container || null;
  } catch (caught) { error = caught.message; }
  return renderPage(context, template, {
    service: serviceJson, container, error,
  }, { title: `Container ${container?.name || ""} — Docker — Symbio` });
});

protectedRoutes.get("/servers/:serverId/services/:serviceId/edit", async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.serverId !== server.id) return context.notFound();
  let configuration = {};
  try { configuration = JSON.parse(service.configuration || "{}"); } catch { configuration = {}; }
  return renderPage(context, "service-form", {
    service: { ...service.toJSON(), ...configuration },
    error: context.req.query("error"),
    isDatabase: service.type === "mysql" || service.type === "postgresql",
    isHttpProbe: service.type === "nginx" || service.type === "apache",
  }, { title: `Edit ${service.displayName} — Symbio` });
});

protectedRoutes.post("/servers/:serverId/services/:serviceId/edit", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  try {
    const configuration = {};
    if (String(form.host || "").trim()) configuration.host = String(form.host).trim().slice(0, 255);
    if (form.port) configuration.port = integerInRange(form.port, null, 1, 65535);
    if (String(form.probeUrl || "").trim()) configuration.probeUrl = normalizeHttpUrl(form.probeUrl);
    if (String(form.username || "").trim()) configuration.username = String(form.username).trim().slice(0, 64);
    if (String(form.password || "").length) configuration.password = String(form.password).slice(0, 255);
    service.enabled = form.enabled === "1";
    service.configuration = JSON.stringify(configuration);
    await sequelize.transaction(async (transaction) => {
      await service.save({ transaction });
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/servers/${server.id}/services/${service.id}`);
  } catch (error) {
    return context.redirect(`/servers/${server.id}/services/${service.id}/edit?error=${encodeURIComponent(error.message)}`);
  }
});

// ── Service Actions (Start / Stop / Restart / Reload) ──

/** Helper: calls the agent bridge directly for nginx/apache-specific endpoints. */
const serviceBridgeFetch = async (path, method = "GET", body = null) => {
  const response = await fetch(`${config.agentBridgeUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.agentToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Service request failed.");
  return payload;
};

/** Generic service restart — executes systemctl.restart via the agent bridge. */
protectedRoutes.post("/servers/:serverId/services/:serviceId/restart", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.serverId !== server.id) return context.notFound();
  try {
    // Map service type to the systemd service name
    const serviceName = service.type === "nginx" ? "nginx"
      : service.type === "apache" ? "apache2"
      : service.type === "docker" ? "docker"
      : service.type === "mysql" ? "mysql"
      : service.type === "postgresql" ? "postgresql"
      : service.type === "redis" ? "redis-server"
      : service.type === "pm2" ? null
      : service.type;
    if (serviceName) {
      await executeSkillActions([{ action: "systemctl.restart", params: { service: serviceName } }]);
    }
    return context.redirect(`/servers/${server.id}/services/${service.id}?restarted=1`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

// ── Docker Container Actions ──

protectedRoutes.post("/servers/:serverId/services/:serviceId/docker/container/:containerId/action", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "docker" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const action = String(form.action || "");
  const container = String(form.container || "");
  const allowed = new Set(["start", "stop", "restart", "remove"]);
  if (!allowed.has(action)) return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent("Invalid action.")}`);
  try {
    const actionType = action === "remove" ? "docker.remove" : `docker.${action}`;
    await executeSkillActions([{ action: actionType, params: { container } }]);
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

// ── Docker Volume / Prune Actions ──

protectedRoutes.post("/servers/:serverId/services/:serviceId/docker/volume/:name/remove", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "docker" || service.serverId !== server.id) return context.notFound();
  const volume = context.req.param("name");
  try {
    await executeSkillActions([{ action: "docker.remove-volume", params: { volume } }]);
    return context.redirect(`/servers/${server.id}/services/${service.id}?tab=volumes&action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?tab=volumes&error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:serverId/services/:serviceId/docker/prune", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "docker" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const pruneType = String(form.type || "system");
  const actionMap = { system: "docker.prune", images: "docker.prune-images", volumes: "docker.prune-volumes" };
  const actionType = actionMap[pruneType];
  if (!actionType) return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent("Invalid prune type.")}`);
  try {
    await executeSkillActions([{ action: actionType, params: {} }]);
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

// ── PM2 Process Actions ──

protectedRoutes.post("/servers/:serverId/services/:serviceId/pm2/process/action", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "pm2" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const action = String(form.action || "");
  const name = String(form.name || "");
  const allowed = new Set(["start", "stop", "restart", "delete"]);
  if (!allowed.has(action) || !name) return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent("Invalid PM2 action.")}`);
  try {
    await executeSkillActions([{ action: `pm2.${action}`, params: { name } }]);
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

// ── Nginx Site Management ──

protectedRoutes.post("/servers/:serverId/services/:serviceId/nginx/enable-site", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "nginx" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const site = String(form.site || "");
  try {
    await serviceBridgeFetch("/api/v1/services/nginx/enable-site", "POST", { site });
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:serverId/services/:serviceId/nginx/disable-site", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "nginx" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const site = String(form.site || "");
  try {
    await serviceBridgeFetch("/api/v1/services/nginx/disable-site", "POST", { site });
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

// ── Apache Site Management ──

protectedRoutes.post("/servers/:serverId/services/:serviceId/apache/enable-site", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "apache" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const site = String(form.site || "");
  try {
    await serviceBridgeFetch("/api/v1/services/apache/enable-site", "POST", { site });
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

protectedRoutes.post("/servers/:serverId/services/:serviceId/apache/disable-site", requireCsrf, async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "apache" || service.serverId !== server.id) return context.notFound();
  const form = context.get("form");
  const site = String(form.site || "");
  try {
    await serviceBridgeFetch("/api/v1/services/apache/disable-site", "POST", { site });
    return context.redirect(`/servers/${server.id}/services/${service.id}?action=ok`);
  } catch (caught) {
    return context.redirect(`/servers/${server.id}/services/${service.id}?error=${encodeURIComponent(caught.message)}`);
  }
});

/** Lists tables in a MySQL database. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/mysql/databases/:db/tables", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "mysql") return context.notFound();
  const db = context.req.param("db");
  const { fetchMySQLTables } = await import("../services/mysql.service.js");
  let tables = [];
  let error = "";
  try {
    const data = await fetchMySQLTables(db);
    tables = data.tables || [];
  } catch (caught) { error = caught.message; }
  return renderPage(context, "components/services/mysql-tables", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, tables, error,
  }, { title: `${db} — MySQL — Symbio` });
});

/** Browses data from a MySQL table with pagination and search. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/mysql/databases/:db/tables/:table/browse", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "mysql") return context.notFound();
  const db = context.req.param("db");
  const table = context.req.param("table");
  const page = Math.max(1, parseInt(context.req.query("page") || "1", 10) || 1);
  const search = context.req.query("search") || "";
  const { fetchMySQLBrowse } = await import("../services/mysql.service.js");
  let columns = [];
  let rows = [];
  let total = 0;
  let error = "";
  try {
    const data = await fetchMySQLBrowse(db, table, page, search);
    columns = data.columns || [];
    total = data.total || 0;
    const rawRows = data.rows || [];
    rows = rawRows.map((row) => columns.map((col) => {
      const val = row[col];
      return val === null ? "NULL" : val instanceof Date ? val.toISOString() : String(val);
    }));
  } catch (caught) { error = caught.message; }
  const totalPages = Math.max(1, Math.ceil(total / 100));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const prevPage = page - 1;
  const nextPage = page + 1;
  return renderPage(context, "components/services/mysql-browse", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, tableName: table, columns, rows, error,
    page, search, total, totalPages, perPage: 100, hasPrev, hasNext, prevPage, nextPage,
  }, { title: `${table} — ${db} — MySQL — Symbio` });
});

/** Lists tables in a PostgreSQL database. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/postgresql/databases/:db/tables", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "postgresql") return context.notFound();
  const db = context.req.param("db");
  const { fetchPGTables } = await import("../services/postgresql.service.js");
  let tables = [];
  let error = "";
  try {
    const data = await fetchPGTables(db);
    tables = data.tables || [];
  } catch (caught) { error = caught.message; }
  return renderPage(context, "components/services/postgresql-tables", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, tables, error,
  }, { title: `${db} — PostgreSQL — Symbio` });
});

/** Browses data from a PostgreSQL table with pagination and search. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/postgresql/databases/:db/schemas/:schema/tables/:table/browse", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "postgresql") return context.notFound();
  const db = context.req.param("db");
  const schema = context.req.param("schema");
  const table = context.req.param("table");
  const page = Math.max(1, parseInt(context.req.query("page") || "1", 10) || 1);
  const search = context.req.query("search") || "";
  const { fetchPGBrowse } = await import("../services/postgresql.service.js");
  let columns = [];
  let rows = [];
  let total = 0;
  let error = "";
  try {
    const data = await fetchPGBrowse(db, schema, table, page, search);
    columns = data.columns || [];
    total = data.total || 0;
    const rawRows = data.rows || [];
    rows = rawRows.map((row) => columns.map((col) => {
      const val = row[col];
      return val === null ? "NULL" : val instanceof Date ? val.toISOString() : String(val);
    }));
  } catch (caught) { error = caught.message; }
  const totalPages = Math.max(1, Math.ceil(total / 100));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const prevPage = page - 1;
  const nextPage = page + 1;
  return renderPage(context, "components/services/postgresql-browse", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, schemaName: schema, tableName: table, columns, rows, error,
    page, search, total, totalPages, perPage: 100, hasPrev, hasNext, prevPage, nextPage,
  }, { title: `${schema}.${table} — ${db} — PostgreSQL — Symbio` });
});

protectedRoutes.get("/applications", async (context) => {
  const tagId = Number(context.req.query("tag"));
  let applications = decorateStatuses(await loadApplications(true));
  if (Number.isInteger(tagId)) {
    const assignments = await models.ApplicationTagAssignment.findAll({ where: { applicationTagId: tagId } });
    const ids = new Set(assignments.map((item) => item.applicationId));
    applications = applications.filter((item) => ids.has(item.id));
  }
  const aiNotConfigured = !(await isLlmConfigured());
  return renderPage(context, "applications-list", { applications, tags: await tagChoices(), aiNotConfigured }, { title: "Applications — Symbio" });
});

/** Normalizes a raw AI-discovered app object for the wizard templates. */
const normalizeDiscoveredApp = (raw, index) => {
  const name = String(raw.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  const displayName = String(raw.displayName || name || "").trim().slice(0, 120);
  const healthCheckUrl = String(raw.healthCheckUrl || "").trim();
  const directory = String(raw.directory || "").trim();
  const rawLogs = Array.isArray(raw.logPaths) ? raw.logPaths : (String(raw.logPaths || "")).split("\n");
  const aiLogs = rawLogs.map((p) => String(p).trim()).filter(Boolean);
  const type = ["node", "php", "python", "nginx", "apache", "static", "go", "docker", "java", "ruby"].includes(raw.type) ? raw.type : "other";
  return {
    index, name, displayName, healthCheckUrl, directory, type,
    selected: !!(name && healthCheckUrl),
    aiLogs: aiLogs.map((path, logIndex) => ({ path, logIndex, selected: true })),
    logCount: aiLogs.length,
    useDirectory: true,
  };
};

/** Builds a concise (~600 char) server context string for the AI log analysis prompt. */
const buildAskContext = (server, status, procResult, pkgResult, logType) => {
  const lines = [];
  const hostname = server?.hostname || server?.displayName || "server";
  const osName = server?.hardware?.osName || "Linux";
  const kernel = server?.hardware?.kernelVersion || server?.kernelVersion || "";
  const uptimeLabel = status?.uptimeSeconds ? formatUptime(status.uptimeSeconds) : "unknown";
  lines.push(`- Host: ${hostname} (${osName}${kernel ? ", kernel " + kernel : ""}), up ${uptimeLabel}`);
  const cpu = status ? `CPU: ${formatPercent(status.cpuPercent)}` : "";
  const ram = status ? `RAM: ${formatBytes(status.memoryUsedBytes)} / ${formatBytes(status.memoryTotalBytes)}` : "";
  const disk = status ? `Disk: ${formatBytes(status.diskUsedBytes)} / ${formatBytes(status.diskTotalBytes)}` : "";
  if (cpu || ram || disk) lines.push(`- ${[cpu, ram, disk].filter(Boolean).join(", ")}`);
  if (pkgResult) {
    const pkgs = (Array.isArray(pkgResult) ? pkgResult : pkgResult.packages || []).filter((p) => /nginx|apache|httpd|node|python|php|java|ruby|go|gunicorn|uwsgi|mysql|postgres|mongo|redis|elastic|caddy|docker/i.test(p.name)).map((p) => p.name).slice(0, 15);
    if (pkgs.length) lines.push(`- Installed: ${pkgs.join(", ")}`);
  }
  if (procResult) {
    const procs = (Array.isArray(procResult) ? procResult : procResult.processes || []).filter((p) => /node|python|php|java|ruby|go|nginx|apache|httpd|gunicorn|uwsgi|daphne|unicorn|passenger|dotnet/i.test(p.command)).slice(0, 10);
    if (procs.length) lines.push(`- Active: ${procs.map((p) => (p.command || "").slice(0, 60)).join(", ")}`);
  }
  if (logType) lines.push(`- Log type: ${logType}`);
  return "Server context:\n" + lines.join("\n");
};

/**
 * Builds a page-aware context string for the global AI bar POST /ai/bar.
 * Gathers basic server metrics plus context specific to the page the user is on
 * (alerts, applications, pending actions, etc.) so the AI understands the current view.
 * Returns [contextString, label, logType] where label/hostname is used for history metadata.
 */
const buildAiBarContext = async (sourcePage) => {
  const server = await models.Server.findOne({ where: { slug: "main-server" }, raw: true });
  const serverId = server?.id || 1;
  const status = await models.ServerStatus.findOne({ where: { serverId }, order: [["observedAt", "DESC"]], raw: true }).catch(() => null);
  const hostname = server?.hostname || server?.displayName || "Main Server";
  const lines = [];
  lines.push(`Host: ${hostname} (${server?.hardware?.osName || "Linux"}), up ${status?.uptimeSeconds ? formatUptime(status.uptimeSeconds) : "unknown"}`);
  if (status) {
    lines.push(`CPU: ${(status.cpuPercent || 0).toFixed(1)}%, RAM: ${formatBytes(status.memoryUsedBytes || 0)}/${formatBytes(status.memoryTotalBytes || 0)}, Disk: ${formatBytes(status.diskUsedBytes || 0)}/${formatBytes(status.diskTotalBytes || 0)}, Load: ${(status.load1 || 0).toFixed(2)}/${(status.load5 || 0).toFixed(2)}/${(status.load15 || 0).toFixed(2)}`);
  }
  // Page-specific enrichment
  if (sourcePage === "/dashboard") {
    // General dashboard — status already included above
  } else if (sourcePage.startsWith("/alerts")) {
    const [firingCount, rulesCount] = await Promise.all([
      models.AlertEvent.count({ where: { status: "firing" } }),
      models.AlertRule.count({ where: { enabled: true } }),
    ]);
    lines.push(`\nAlerting: ${firingCount} firing alerts, ${rulesCount} enabled rules`);
  } else if (sourcePage.startsWith("/servers")) {
    // Server-specific — could add more detail per server ID
  } else if (sourcePage.startsWith("/applications")) {
    const appCount = await models.Application.count({ where: { deletedAt: null } });
    lines.push(`\nApplications: ${appCount} registered`);
  } else if (sourcePage.startsWith("/ai/command-center") || sourcePage.startsWith("/ai/actions")) {
    const pendingCount = await models.SkillFinding.count({ where: { status: "pending" } });
    lines.push(`\nAI Command Center: ${pendingCount} pending actions`);
  } else if (sourcePage.startsWith("/ai/history")) {
    lines.push("\nAI history page");
  } else if (sourcePage.startsWith("/ai")) {
    lines.push("\nAI section");
  } else if (sourcePage.startsWith("/settings")) {
    lines.push("\nSettings page");
  }
  return [lines.join("\n"), hostname, "server-context"];
};

/** Page 1 — Intro screen before starting the AI scan. */
protectedRoutes.get("/applications/ai-discover", async (context) => {
  const llmRow = await models.Setting.findByPk("llm_config");
  let llmError = "";
  let isAnthropic = false;
  if (!llmRow) { llmError = "LLM is not configured."; }
  else {
    try {
      const cfg = JSON.parse(llmRow.value);
      if (!cfg.provider || !cfg.secretKey) llmError = "LLM configuration is incomplete.";
      else if (cfg.provider === "anthropic") isAnthropic = true;
    } catch { llmError = "LLM configuration is invalid."; }
  }
  return renderPage(context, "ai-discover-intro", {
    llmError, isAnthropic, csrfToken: context.get("auth")?.session?.csrfToken || "",
  }, { title: "AI Application Discovery — Symbio" });
});

/** Page 2 — Gathers system data, calls the LLM, shows discovered apps for selection. */
protectedRoutes.post("/applications/ai-discover", requireCsrf, async (context) => {
  const llmRow = await models.Setting.findByPk("llm_config");
  if (!llmRow) return renderPage(context, "ai-discover-apps", { error: "LLM is not configured.", apps: [], appCount: 0, parseError: false, rawResponse: "" }, { title: "AI Discovery — Symbio" });
  let config;
  try { config = JSON.parse(llmRow.value); } catch { config = null; }
  if (!config?.secretKey || !config?.provider) return renderPage(context, "ai-discover-apps", { error: "LLM configuration is incomplete.", apps: [], appCount: 0, parseError: false, rawResponse: "" }, { title: "AI Discovery — Symbio" });
  if (config.provider === "anthropic") return renderPage(context, "ai-discover-apps", { error: "Application discovery requires DeepSeek or OpenAI. Change your provider in Settings.", apps: [], appCount: 0, parseError: false, rawResponse: "" }, { title: "AI Discovery — Symbio" });

  const [procResult, portResult, pkgResult] = await Promise.allSettled([fetchProcessList(), fetchListeningPorts(), fetchInstalledPackages()]);
  const processes = procResult.status === "fulfilled" ? (procResult.value.processes || []) : [];
  const ports = portResult.status === "fulfilled" ? (portResult.value.ports || []) : [];
  const packages = pkgResult.status === "fulfilled" ? (pkgResult.value.packages || []) : [];

  const systemInfo = buildDiscoveryContext(processes, ports, packages);
  const result = await discoverApplications({
    provider: config.provider, apiKey: config.secretKey, endpoint: config.endpoint, model: config.model, systemInfo,
  });
  if (result.usage) await accumulateUsage(result.usage, { model: config.model, source: "discovery" });

  let apps = [];
  let parseError = false;
  if (result.content) {
    try { const parsed = JSON.parse(result.content); apps = Array.isArray(parsed.applications) ? parsed.applications : []; } catch { parseError = true; }
  }
  apps = apps.filter((a) => a.name).map((raw, i) => normalizeDiscoveredApp(raw, i));
  if (!apps.length && result.error) {
    return renderPage(context, "ai-discover-apps", { error: result.error, apps: [], appCount: 0, parseError: false, rawResponse: "" }, { title: "AI Discovery — Symbio" });
  }
  return renderPage(context, "ai-discover-apps", {
    error: result.error || "", apps, appCount: apps.length, parseError, rawResponse: result.rawResponse || "",
  }, { title: "AI Discovery — Symbio" });
});

/** Page 3 — For each selected app, let user confirm directory and log paths. */
protectedRoutes.post("/applications/ai-discover/configure", requireCsrf, async (context) => {
  const form = context.get("form");
  const appCount = parseInt(form.appCount || "0");
  const selectedApps = [];
  for (let i = 0; i < appCount; i++) {
    if (form[`app_${i}_selected`] !== "1") continue;
    const aiLogCount = parseInt(form[`app_${i}_logCount`] || "0");
    const aiLogs = [];
    for (let j = 0; j < aiLogCount; j++) {
      const path = String(form[`app_${i}_log_${j}`] || "").trim();
      if (path) aiLogs.push({ path, logIndex: j, selected: true });
    }
    selectedApps.push({
      index: i,
      name: String(form[`app_${i}_name`] || "").trim(),
      displayName: String(form[`app_${i}_displayName`] || "").trim(),
      healthCheckUrl: String(form[`app_${i}_healthCheckUrl`] || "").trim(),
      directory: String(form[`app_${i}_directory`] || "").trim(),
      type: String(form[`app_${i}_type`] || "other").trim(),
      aiLogs,
      logCount: aiLogs.length,
      useDirectory: true,
    });
  }
  if (!selectedApps.length) {
    return renderPage(context, "ai-discover-configure", { apps: [], appCount: 0, error: "No applications were selected. Go back and check at least one." }, { title: "AI Discovery — Symbio" });
  }
  return renderPage(context, "ai-discover-configure", {
    apps: selectedApps, appCount: selectedApps.length, error: "",
  }, { title: "AI Discovery — Symbio" });
});

/** Page 4 — Creates selected apps with confirmed logs, shows result. */
protectedRoutes.post("/applications/ai-bulk-add", requireCsrf, async (context) => {
  const form = context.get("form");
  const appCount = parseInt(form.appCount || "0");
  const server = await models.Server.findOne({ where: { slug: "main-server" } });
  const results = [];
  for (let i = 0; i < appCount; i++) {
    const name = String(form[`app_${i}_name`] || "").trim();
    const displayName = String(form[`app_${i}_displayName`] || "").trim();
    const healthCheckUrl = String(form[`app_${i}_healthCheckUrl`] || "").trim();
    const useDirectory = form[`app_${i}_useDirectory`] || "";
    const directory = String(useDirectory || form[`app_${i}_customDir`] || "").trim();
    const rawCheckedLogs = form[`app_${i}_log[]`] || [];
    const checkedLogs = Array.isArray(rawCheckedLogs) ? rawCheckedLogs : [rawCheckedLogs];
    const customLogs = [form[`app_${i}_customLog_0`], form[`app_${i}_customLog_1`]].filter(Boolean).map((p) => String(p).trim()).filter(Boolean);
    const allLogs = [...checkedLogs, ...customLogs].filter(Boolean);
    if (!name || !displayName || !healthCheckUrl) continue;

    try {
      const app = await models.Application.create({
        serverId: server.id, name, displayName,
        healthCheckMethod: "http", healthCheckUrl,
        healthCheckTimeoutMs: 5000, slowThresholdMs: 1500,
        responseTextMatch: null,
      });
      for (const path of allLogs) {
        try {
          await models.ApplicationLog.create({
            applicationId: app.id,
            displayName: `${displayName} — ${path.split("/").pop()}`,
            filePath: path, tailLines: 200,
          });
        } catch {} // log creation is best-effort
      }
      await touchAgentConfig();
      results.push({ name, displayName, id: app.id, logCount: allLogs.length, success: true, error: "" });
    } catch (error) {
      results.push({ name, displayName, id: null, logCount: 0, success: false, error: error.message });
    }
  }
  return renderPage(context, "ai-discover-confirm", { results }, { title: "AI Discovery — Symbio" });
});

/** Renders a shared application form for create and edit operations. */
const renderApplicationForm = async (context, application = null, error = "") => {
  const tags = await tagChoices(application?.id);
  return renderPage(context, "application-form", {
    application: { ...(application?.toJSON() || { healthCheckTimeoutMs: 5000, slowThresholdMs: 1500 }), tagNames: tags.filter((tag) => tag.selected).map((tag) => tag.name).join(", ") },
    editing: Boolean(application), tags, tagWhitelist: JSON.stringify(tags.map((tag) => tag.name)), error,
  }, { title: `${application ? "Edit" : "Add"} Application — Symbio` });
};

protectedRoutes.get("/applications/new", (context) => renderApplicationForm(context));

/** Validates and normalizes editable application fields from one form body. */
const applicationValues = (form) => {
  const name = String(form.name || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(name)) throw new Error("Internal name must be a 3–64 character slug.");
  const displayName = String(form.displayName || "").trim();
  if (!displayName || displayName.length > 120) throw new Error("Display name is required and may contain at most 120 characters.");
  const healthCheckTimeoutMs = integerInRange(form.healthCheckTimeoutMs, 5000, 1000, 30_000);
  const slowThresholdMs = integerInRange(form.slowThresholdMs, 1500, 100, 29_999);
  if (slowThresholdMs >= healthCheckTimeoutMs) throw new Error("Slow threshold must be lower than the timeout.");
  const responseTextMatch = String(form.responseTextMatch || "").trim();
  if (responseTextMatch.length > 300) throw new Error("Response regular expressions may contain at most 300 characters.");
  try { if (responseTextMatch) new RegExp(responseTextMatch, "u"); } catch { throw new Error("Response regular expression is invalid."); }
  return {
    name, displayName, healthCheckMethod: "http", healthCheckUrl: normalizeHttpUrl(form.healthCheckUrl),
    healthCheckTimeoutMs, slowThresholdMs,
    // Store only a validated pattern; the agent applies it to its existing 64 KiB bounded body.
    responseTextMatch: responseTextMatch || null,
  };
};

/** Validates source configuration once; filesystem access remains agent-only. */
const applicationLogValues = (form) => {
  const displayName = String(form.displayName || "").trim();
  const filePath = String(form.filePath || "").trim();
  const tailLines = Number(form.tailLines || 200);
  if (!displayName || displayName.length > 120) throw new Error("Log name is required and may contain at most 120 characters.");
  if (!filePath.startsWith("/") || filePath.includes("\0") || filePath.split("/").includes("..") || filePath.length > 1024) throw new Error("Log path must be an absolute host path without traversal.");
  if (filePath.startsWith("/var/lib/docker/") || filePath.split("/").includes(".pm2")) throw new Error("Docker and PM2 log paths are not supported.");
  if (!LOG_TAIL_LIMITS.includes(tailLines)) throw new Error("Choose a supported tail limit.");
  return { displayName, filePath, tailLines };
};

/** Builds select-ready tail choices without template-side equality logic. */
const logTailChoices = (selected = 200) => LOG_TAIL_LIMITS.map((value) => ({ value, selected: Number(selected) === value }));

/** Renders the small application-scoped source form for active applications only. */
const renderApplicationLogForm = async (context, application, log = null, error = "") => renderPage(context, "application-log-form", {
  application: application.toJSON(), log: log?.toJSON() || { tailLines: 200 }, editing: Boolean(log), error, tailChoices: logTailChoices(log?.tailLines),
}, { title: `${log ? "Edit" : "Add"} Log — ${application.displayName} — Symbio` });

/** Loads a source only when it belongs to the route's application to prevent ID substitution. */
const applicationLogFor = (applicationId, logId) => models.ApplicationLog.findOne({ where: { id: logId, applicationId } });

protectedRoutes.post("/applications", requireCsrf, async (context) => {
  const form = context.get("form");
  try {
    const server = await models.Server.findOne({ where: { slug: "main-server" } });
    let application;
    await sequelize.transaction(async (transaction) => {
      application = await models.Application.create({ serverId: server.id, ...applicationValues(form) }, { transaction });
      await saveApplicationTags(application.id, form, transaction);
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}`);
  } catch (error) {
    return renderApplicationForm(context, null, error.message);
  }
});

protectedRoutes.get("/applications/:id/logs/new", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  return renderApplicationLogForm(context, application);
});

protectedRoutes.post("/applications/:id/logs", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  try {
    let log;
    await sequelize.transaction(async (transaction) => {
      log = await models.ApplicationLog.create({ applicationId: application.id, ...applicationLogValues(context.get("form")) }, { transaction });
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}/logs/${log.id}`);
  } catch (error) { return renderApplicationLogForm(context, application, null, error.message); }
});

protectedRoutes.get("/applications/:id/logs/:logId/edit", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.notFound();
  return renderApplicationLogForm(context, application, log);
});

protectedRoutes.post("/applications/:id/logs/:logId/edit", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.notFound();
  try {
    await sequelize.transaction(async (transaction) => {
      await log.update(applicationLogValues(context.get("form")), { transaction });
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}/logs/${log.id}`);
  } catch (error) { return renderApplicationLogForm(context, application, log, error.message); }
});

protectedRoutes.post("/applications/:id/logs/:logId/delete", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.notFound();
  await sequelize.transaction(async (transaction) => { await log.destroy({ transaction }); await touchAgentConfig(transaction); });
  return context.redirect(`/applications/${application.id}`);
});

/** Renders a manual-refresh viewer so the core log workflow remains usable without JavaScript. */
protectedRoutes.get("/applications/:id/logs/:logId", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"), { paranoid: false });
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.notFound();
  const requestedLimit = Number(context.req.query("limit"));
  const limit = LOG_TAIL_LIMITS.includes(requestedLimit) ? requestedLimit : log.tailLines;
  const aiNotConfigured = !(await isLlmConfigured());
  let result;
  let error = "";
  try { result = await readApplicationLog(log.id, limit); } catch (caught) { error = caught.message; }
  return renderPage(context, "application-log-viewer", {
    application: application.toJSON(), log: log.toJSON(), deleted: Boolean(application.deletedAt), tailChoices: logTailChoices(limit),
    logContent: result?.text || "", bytes: result?.bytes || 0, truncated: result?.truncated, lastReadAt: result ? new Date().toLocaleString() : "Not read", error,
    aiNotConfigured, tailLimit: limit,
  }, { title: `${log.displayName} — ${application.displayName} — Symbio` });
});

protectedRoutes.get("/applications/:id/logs/:logId/content", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"), { paranoid: false });
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.json({ ok: false, error: "Log source not found." }, 404);
  const limit = Number(context.req.query("limit"));
  if (!LOG_TAIL_LIMITS.includes(limit)) return context.json({ ok: false, error: "Choose a supported tail limit." }, 400);
  try { return context.json({ ok: true, ...(await readApplicationLog(log.id, limit)), readAt: new Date().toISOString() }); }
  catch (error) { return context.json({ ok: false, error: error.message }, 502); }
});

protectedRoutes.post("/applications/:id/logs/:logId/search", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"), { paranoid: false });
  const log = application && await applicationLogFor(application.id, context.req.param("logId"));
  if (!log) return context.notFound();
  const query = String(context.get("form").query || "").trim();
  let result;
  let error = "";
  try { result = await searchApplicationLog(log.id, query); } catch (caught) { error = caught.message; }
  return renderPage(context, "application-log-search", {
    application: application.toJSON(), log: log.toJSON(), query, logContent: result?.text || "", bytes: result?.bytes || 0, truncated: result?.truncated, error,
  }, { title: `Search ${log.displayName} — Symbio` });
});

// ---- Application Source Directories ----

/** Renders the small source-directory registration form following the log-source pattern. */
const renderApplicationSourceForm = async (context, application, source = null, error = "") => renderPage(context, "application-source-form", {
  application: application.toJSON(), source: source?.toJSON() || { sourcePath: "" }, editing: Boolean(source), error,
}, { title: `${source ? "Edit" : "Add"} Source Directory — ${application.displayName} — Symbio` });

/** Loads a source only when it belongs to the route's application. */
const applicationSourceFor = (applicationId, sourceId) => models.ApplicationSource.findOne({ where: { id: sourceId, applicationId } });

protectedRoutes.get("/applications/:id/sources/new", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  return renderApplicationSourceForm(context, application);
});

protectedRoutes.post("/applications/:id/sources", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  try {
    await sequelize.transaction(async (transaction) => {
      await models.ApplicationSource.create({ applicationId: application.id, ...sourcePathValues(context.get("form")) }, { transaction });
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}`);
  } catch (error) { return renderApplicationSourceForm(context, application, null, error.message); }
});

protectedRoutes.get("/applications/:id/sources/:sid/edit", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const source = application && await applicationSourceFor(application.id, context.req.param("sid"));
  if (!source) return context.notFound();
  return renderApplicationSourceForm(context, application, source);
});

protectedRoutes.post("/applications/:id/sources/:sid/edit", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const source = application && await applicationSourceFor(application.id, context.req.param("sid"));
  if (!source) return context.notFound();
  try {
    await sequelize.transaction(async (transaction) => {
      await source.update(sourcePathValues(context.get("form")), { transaction });
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}`);
  } catch (error) { return renderApplicationSourceForm(context, application, source, error.message); }
});

protectedRoutes.post("/applications/:id/sources/:sid/delete", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  const source = application && await applicationSourceFor(application.id, context.req.param("sid"));
  if (!source) return context.notFound();
  await sequelize.transaction(async (transaction) => { await source.destroy({ transaction }); await touchAgentConfig(transaction); });
  return context.redirect(`/applications/${application.id}`);
});

protectedRoutes.get("/applications/:id", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"), { paranoid: false });
  if (!application) return context.notFound();
  const range = chartRange(context.req.query("range"));
  const [history, agent, logs, sources] = await Promise.all([models.ApplicationStatus.findAll({
    where: { applicationId: application.id, observedAt: { [Op.gte]: new Date(Date.now() - range.milliseconds) } },
    order: [["observedAt", "ASC"]], raw: true,
  }), models.Agent.findOne({ where: { serverId: application.serverId } }), models.ApplicationLog.findAll({ where: { applicationId: application.id }, order: [["id", "ASC"]] }), models.ApplicationSource.findAll({ where: { applicationId: application.id }, order: [["id", "ASC"]] })]);
  const assignments = await tagChoices(application.id);
  const tags = assignments.filter((tag) => tag.selected);
  return renderPage(context, "application-detail", {
    application: application.toJSON(), deleted: Boolean(application.deletedAt), tags, range,
    latest: history.length ? decorateStatuses([{ ...history.at(-1), agentLastSeenAt: agent?.lastSeenAt || null }])[0] : null,
    responseChart: renderLineChart([{ name: "Response time", points: bucketSeries(history, "responseTimeMs", range) }], "Response time", " ms"),
    recent: decorateStatuses(history.slice(-20).reverse()), logs: logs.map((log) => log.toJSON()), sources: sources.map((source) => source.toJSON()),
  }, { title: `${application.displayName} — Symbio` });
});

protectedRoutes.get("/applications/:id/edit", async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  return renderApplicationForm(context, application);
});

protectedRoutes.post("/applications/:id/edit", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  try {
    await sequelize.transaction(async (transaction) => {
      await application.update(applicationValues(context.get("form")), { transaction });
      await saveApplicationTags(application.id, context.get("form"), transaction);
      await touchAgentConfig(transaction);
    });
    return context.redirect(`/applications/${application.id}`);
  } catch (error) {
    return renderApplicationForm(context, application, error.message);
  }
});

protectedRoutes.post("/applications/:id/delete", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"));
  if (!application) return context.notFound();
  await sequelize.transaction(async (transaction) => {
    await application.destroy({ transaction });
    await touchAgentConfig(transaction);
  });
  return context.redirect("/applications");
});

protectedRoutes.post("/applications/:id/restore", requireCsrf, async (context) => {
  const application = await models.Application.findByPk(context.req.param("id"), { paranoid: false });
  if (!application) return context.notFound();
  await sequelize.transaction(async (transaction) => {
    await application.restore({ transaction });
    await touchAgentConfig(transaction);
  });
  return context.redirect(`/applications/${application.id}`);
});

protectedRoutes.get("/application-tags", async (context) => {
  const tags = await sequelize.query(`SELECT tag.*, COUNT(assignment.application_id) AS applicationCount
    FROM application_tags tag LEFT JOIN application_tag_assignments assignment ON assignment.application_tag_id = tag.id
    GROUP BY tag.id ORDER BY tag.name COLLATE NOCASE`, { type: QueryTypes.SELECT });
  return renderPage(context, "tags-list", { tags, error: context.req.query("error") }, { title: "Application Tags — Symbio" });
});

protectedRoutes.get("/application-tags/new", (context) => renderPage(context, "tag-form", {}, { title: "Add Tag — Symbio" }));
protectedRoutes.post("/application-tags", requireCsrf, async (context) => {
  const name = String(context.get("form").name || "").trim();
  if (!name || name.length > 50) return renderPage(context, "tag-form", { error: "Tag name is required and may contain at most 50 characters." }, { title: "Add Tag — Symbio" });
  try {
    const tag = await models.ApplicationTag.create({ name });
    return context.redirect(`/application-tags/${tag.id}/edit`);
  } catch {
    return renderPage(context, "tag-form", { error: "Tag name must be unique." }, { title: "Add Tag — Symbio" });
  }
});

protectedRoutes.get("/application-tags/:id/edit", async (context) => {
  const tag = await models.ApplicationTag.findByPk(context.req.param("id"));
  if (!tag) return context.notFound();
  return renderPage(context, "tag-form", { tag: tag.toJSON() }, { title: `Edit ${tag.name} — Symbio` });
});

protectedRoutes.post("/application-tags/:id/edit", requireCsrf, async (context) => {
  const tag = await models.ApplicationTag.findByPk(context.req.param("id"));
  if (!tag) return context.notFound();
  const name = String(context.get("form").name || "").trim();
  if (!name || name.length > 50) return renderPage(context, "tag-form", { tag: tag.toJSON(), error: "Tag name is invalid." }, { title: `Edit ${tag.name} — Symbio` });
  try { await tag.update({ name }); } catch { return renderPage(context, "tag-form", { tag: tag.toJSON(), error: "Tag name must be unique." }, { title: `Edit ${tag.name} — Symbio` }); }
  return context.redirect("/application-tags");
});

protectedRoutes.post("/application-tags/:id/delete", requireCsrf, async (context) => {
  const applicationTagId = Number(context.req.param("id"));
  const count = await models.ApplicationTagAssignment.count({ where: { applicationTagId } });
  if (count > 0) return context.redirect("/application-tags?error=Remove+this+tag+from+applications+before+deleting+it.");
  await models.ApplicationTag.destroy({ where: { id: applicationTagId } });
  return context.redirect("/application-tags");
});

protectedRoutes.get("/settings", async (context) => {
  const auth = context.get("auth");
  const tab = context.req.query("tab") || "general";
  // Compute the server's timezone for display in the General tab
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset() / 60;
  const offsetStr = offset >= 0 ? `UTC+${offset}` : `UTC${offset}`;
  const serverTimezone = `${offsetStr} — ${timezone}`;
  // Load users list (for users tab)
  const users = await models.User.findAll({ order: [["role", "ASC"], ["username", "ASC"]] });
  const usersDecorated = users.map((u) => ({
    id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role,
    isSuperadmin: u.role === "superadmin",
  }));
  // Load LLM config (for llm tab)
  const llmRow = await models.Setting.findByPk("llm_config");
   let llmConfig = { providerIsOpenai: true, secretKey: "", endpoint: "", model: "", thinkingEnabled: true, reasoningEffort: "high", language: "en", personality: "professional", customInstruction: "" };
   if (llmRow) {
     try {
       const parsed = JSON.parse(llmRow.value);
       llmConfig = {
         providerIsOpenai: parsed.provider === "openai",
         providerIsAnthropic: parsed.provider === "anthropic",
         providerIsDeepseek: parsed.provider === "deepseek",
         secretKey: parsed.secretKey || "",
         endpoint: parsed.endpoint || "",
         model: parsed.model || "",
         thinkingEnabled: parsed.thinkingEnabled !== false,
         reasoningEffort: parsed.reasoningEffort || "high",
         reasoningEffortIsMax: (parsed.reasoningEffort || "high") === "max",
         language: parsed.language || "en",
         personality: parsed.personality || "professional",
         customInstruction: parsed.customInstruction || "",
         languageEn: (parsed.language || "en") === "en",
         languageDe: parsed.language === "de",
         languageId: parsed.language === "id",
         languageSu: parsed.language === "su",
         personalityDefault: (parsed.personality || "professional") === "default",
         personalityProfessional: (parsed.personality || "professional") === "professional",
         personalityFriendly: parsed.personality === "friendly",
         personalityConcise: parsed.personality === "concise",
         personalityTechnical: parsed.personality === "technical",
         personalityEducational: parsed.personality === "educational",
         personalitySatirical: parsed.personality === "satirical",
       };
     } catch {}
   }

  // Build model dropdown options grouped by provider
  const modelOptions = [];
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    modelOptions.push({ optgroupLabel: provider.charAt(0).toUpperCase() + provider.slice(1) });
    for (const m of models) {
      modelOptions.push({ value: m, label: m, selected: llmConfig.model === m, isModel: true, provider, logo: PROVIDER_LOGOS[provider] });
    }
  }
  // Add "Other" option at the end
  const isCustomModel = llmConfig.model && !Object.values(PROVIDER_MODELS).flat().includes(llmConfig.model);
  modelOptions.push({ isCustom: isCustomModel, customModel: isCustomModel ? llmConfig.model : "" });
  const balanceResult = context.req.query("balanceResult") || "";
  // Load notification channels for messaging tab
  const channels = await models.NotificationChannel.findAll({ raw: true });
  const channelsDecorated = channels.map(c => ({
    ...c,
    configParsed: parseJson(c.config, {}),
    isSlack: c.type === "slack",
  }));
  // Read server-wide theme for the General tab dropdown
  let currentTheme = "blue";
  try {
    const themeRow = await models.Setting.findByPk("theme");
    if (themeRow) currentTheme = themeRow.value || "blue";
  } catch {}
  // Read dashboard summary TTL setting
  let dashboardTtl = 86400;
  try {
    const ttlRow = await models.Setting.findByPk("dashboard_summary_ttl");
    if (ttlRow) dashboardTtl = parseInt(ttlRow.value) || 86400;
  } catch {}
  return renderPage(context, "settings", {
    serverTimezone,
    users: usersDecorated,
    isSuperadmin: auth.user.role === "superadmin",
    llmConfig,
    modelOptions,
    hasCustomModel: isCustomModel,
    balanceResult,
    isDeepseekProvider: llmConfig.providerIsDeepseek,
    llmSaved: context.req.query("llmSaved") === "1",
    llmError: context.req.query("llmError") || "",
    tabGeneral: tab === "general",
    tabUsers: tab === "users",
    tabLlm: tab === "llm",
    tabMessaging: tab === "messaging",
    channels: channelsDecorated,
    messagingSaved: tab === "messaging" && context.req.query("saved") === "1",
    messagingError: tab === "messaging" ? (context.req.query("error") || "") : "",
    themeChoices: THEME_CHOICES.map((c) => ({ ...c, selected: c.code === currentTheme })),
    themeSaved: tab === "general" && context.req.query("themeSaved") === "1",
    dashboardTtl,
    dashboardTtl3600: dashboardTtl === 3600,
    dashboardTtl21600: dashboardTtl === 21600,
    dashboardTtl43200: dashboardTtl === 43200,
    dashboardTtl86400: dashboardTtl === 86400,
    dashboardTtl259200: dashboardTtl === 259200,
    summaryRefreshed: tab === "general" && context.req.query("refreshed") === "1",
    summaryTtlSaved: tab === "general" && context.req.query("ttlSaved") === "1",
  }, { title: "Settings — Symbio" });
});

/** Saves the server-wide UI theme color scheme from the Settings General tab or Wizard step 1. */
protectedRoutes.post("/settings/theme", requireCsrf, async (context) => {
  const form = context.get("form");
  const theme = String(form.theme || "blue").trim();
  const validThemes = THEME_CHOICES.map((c) => c.code);
  if (validThemes.includes(theme)) {
    await models.Setting.upsert({ key: "theme", value: theme, updatedAt: new Date() });
  }
  return context.redirect("/settings?tab=general&themeSaved=1");
});

/** Deletes the cached dashboard summary so it regenerates on next dashboard page load. */
protectedRoutes.post("/settings/dashboard/refresh", requireCsrf, async (context) => {
  try {
    await models.Setting.destroy({ where: { key: "dashboard_summary" } });
  } catch {}
  return context.redirect("/settings?tab=general&refreshed=1");
});

/** Saves the dashboard summary cache TTL (in seconds). */
protectedRoutes.post("/settings/dashboard/ttl", requireCsrf, async (context) => {
  const form = context.get("form");
  const ttl = Math.max(60, parseInt(form.dashboardTtl) || 86400);
  await models.Setting.upsert({ key: "dashboard_summary_ttl", value: String(ttl), updatedAt: new Date() });
  return context.redirect("/settings?tab=general&ttlSaved=1");
});

/** Creates a new admin user. Superadmin only. */
protectedRoutes.post("/settings/users/create", requireCsrf, async (context) => {
  const auth = context.get("auth");
  if (auth.user.role !== "superadmin") return context.text("Forbidden.", 403);
  const form = context.get("form");
  try {
    const username = String(form.username || "").trim().slice(0, 64);
    const email = String(form.email || "").trim().slice(0, 255);
    const displayName = String(form.displayName || "").trim().slice(0, 128);
    if (!username || !email || !displayName) throw new Error("Username, email, and display name are required.");
    const existing = await models.User.findOne({ where: { username } });
    if (existing) throw new Error(`User "${username}" already exists.`);
    const passwordHash = await hashPassword(String(form.password || ""));
    await models.User.create({ username, email, displayName, passwordHash, role: "admin" });
    return context.redirect("/settings?tab=users");
  } catch (error) {
    return context.redirect(`/settings/users/create?error=${encodeURIComponent(error.message)}`);
  }
});

/** Shows the create user form. */
protectedRoutes.get("/settings/users/create", async (context) => {
  const auth = context.get("auth");
  if (auth.user.role !== "superadmin") return context.text("Forbidden.", 403);
  return renderPage(context, "user-form", { isEdit: false, user: {}, error: context.req.query("error") || "" }, { title: "Create User — Symbio" });
});

/** Shows the edit user form. */
protectedRoutes.get("/settings/users/:id/edit", async (context) => {
  const auth = context.get("auth");
  if (auth.user.role !== "superadmin") return context.text("Forbidden.", 403);
  const user = await models.User.findByPk(context.req.param("id"));
  if (!user) return context.notFound();
  if (user.role === "superadmin") return context.text("Cannot edit superadmin user.", 403);
  return renderPage(context, "user-form", { isEdit: true, user: user.toJSON(), error: context.req.query("error") || "" }, { title: `Edit ${user.username} — Symbio` });
});

/** Updates an existing admin user. Superadmin only. */
protectedRoutes.post("/settings/users/:id/edit", requireCsrf, async (context) => {
  const auth = context.get("auth");
  if (auth.user.role !== "superadmin") return context.text("Forbidden.", 403);
  const user = await models.User.findByPk(context.req.param("id"));
  if (!user) return context.notFound();
  if (user.role === "superadmin") return context.text("Cannot edit superadmin user.", 403);
  const form = context.get("form");
  try {
    const email = String(form.email || "").trim().slice(0, 255);
    const displayName = String(form.displayName || "").trim().slice(0, 128);
    if (!email || !displayName) throw new Error("Email and display name are required.");
    user.email = email;
    user.displayName = displayName;
    const newPassword = String(form.password || "").trim();
    if (newPassword) user.passwordHash = await hashPassword(newPassword);
    await user.save();
    return context.redirect("/settings?tab=users");
  } catch (error) {
    return context.redirect(`/settings/users/${user.id}/edit?error=${encodeURIComponent(error.message)}`);
  }
});

/** Deletes an admin user. Superadmin only. */
protectedRoutes.post("/settings/users/:id/delete", requireCsrf, async (context) => {
  const auth = context.get("auth");
  if (auth.user.role !== "superadmin") return context.text("Forbidden.", 403);
  const user = await models.User.findByPk(context.req.param("id"));
  if (!user) return context.notFound();
  if (user.role === "superadmin") return context.text("Cannot delete superadmin user.", 403);
  await user.destroy();
  return context.redirect("/settings?tab=users");
});

/** Saves LLM integration configuration. */
protectedRoutes.post("/settings/llm/save", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  const form = context.get("form");
  const provider = String(form.provider || "openai").trim();
  if (!["openai", "anthropic", "deepseek"].includes(provider)) {
    return context.redirect("/settings?tab=llm&llmError=Invalid+provider.");
  }
  const secretKey = String(form.secretKey || "").trim();
  const endpoint = String(form.endpoint || "").trim();
  const model = String(form.customModel || form.model || "").trim();
  const thinkingEnabled = form.thinkingEnabled === "1";
  const reasoningEffort = form.reasoningEffort === "max" ? "max" : "high";
  const llmLanguage = form.llmLanguage || "en";
  const personality = form.personality || "professional";
  const customInstruction = String(form.customInstruction || "").trim();
  const value = JSON.stringify({ provider, secretKey, endpoint, model, thinkingEnabled, reasoningEffort, language: llmLanguage, personality, customInstruction });
  await models.Setting.upsert({ key: "llm_config", value, updatedAt: new Date() });
  return context.redirect("/settings?tab=llm&llmSaved=1");
});

/** Resets the LLM token usage counter to zero. */
protectedRoutes.post("/settings/llm/reset-usage", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  try { await sequelize.query("DELETE FROM token_usage"); } catch {}
  return context.redirect("/ai/usage?usageReset=1");
});

/** Checks DeepSeek account balance and displays the result. */
protectedRoutes.post("/settings/llm/check-balance", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  const llmRow = await models.Setting.findByPk("llm_config");
  let result = "";
  if (llmRow) {
    try {
      const config = JSON.parse(llmRow.value);
      if (config.secretKey) {
        const data = await checkBalance(config.secretKey);
        const infos = (data.balance_infos || data.balanceInfos || []);
        result = infos.map((b) => `${b.currency || "USD"}: ${b.totalBalance || "0"}`).join(", ") || "No balance info returned.";
      } else { result = "API key not configured."; }
    } catch (error) { result = `Error: ${error.message}`; }
  } else { result = "LLM not configured."; }
  return context.redirect(`/settings?tab=llm&balanceResult=${encodeURIComponent(result)}`);
});

// ---- Setup Wizard ----

/** Setup Wizard — two-step process (language + LLM config). Superadmin only. Can be re-run from settings. */
protectedRoutes.get("/setup-wizard", async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/dashboard");
  const state = await readWizardState();
  const userLang = context.get("auth").user.language || "en";
  // If already completed and no explicit step override, redirect to dashboard
  if (state.completed && !context.req.query("step")) return context.redirect("/dashboard");
  const explicitStep = parseInt(context.req.query("step"));
  if (context.req.query("step") === "skip3") {
    await writeWizardState({ completed: true, step: 3 });
    return context.redirect("/dashboard");
  }
  const step = (explicitStep === 1 || explicitStep === 2 || explicitStep === 3) ? explicitStep : (state.step || 1);
  if (step === 1) {
    // Read current theme from settings to pre-select the dropdown
    let currentTheme = "blue";
    try {
      const themeRow = await models.Setting.findByPk("theme");
      if (themeRow) currentTheme = themeRow.value || "blue";
    } catch {}
    return renderPage(context, "setup-wizard", {
      showStep1: true,
      languageChoices: LANGUAGE_CHOICES.map((c) => ({ ...c, selected: c.code === userLang })),
      themeChoices: THEME_CHOICES.map((c) => ({ ...c, selected: c.code === currentTheme })),
    }, { title: "Setup Wizard — Symbio", standalone: true });
  }
  // Step 2 (and also load data for step 3): pre-fill from existing llm_config if available
  const llmRow = await models.Setting.findByPk("llm_config");
  let provider = "deepseek", secretKey = "", endpoint = "", model = "", thinkingEnabled = true, reasoningEffort = "high";
  let llmLanguage = "en", personality = "professional", customInstruction = "";
  if (llmRow) {
    try {
      const parsed = JSON.parse(llmRow.value);
      provider = parsed.provider || "deepseek";
      secretKey = parsed.secretKey || "";
      endpoint = parsed.endpoint || "";
      model = parsed.model || "";
      thinkingEnabled = parsed.thinkingEnabled !== false;
      reasoningEffort = parsed.reasoningEffort || "high";
      llmLanguage = parsed.language || "en";
      personality = parsed.personality || "professional";
      customInstruction = parsed.customInstruction || "";
    } catch {}
  }
  if (step === 2) {
    const modelOptions = [];
    for (const [prov, models] of Object.entries(PROVIDER_MODELS)) {
      modelOptions.push({ optgroupLabel: prov.charAt(0).toUpperCase() + prov.slice(1) });
      for (const m of models) {
        modelOptions.push({ value: m, label: m, selected: model === m, isModel: true, provider: prov, logo: PROVIDER_LOGOS[prov] });
      }
    }
    const isCustomModel = model && !Object.values(PROVIDER_MODELS).flat().includes(model);
    modelOptions.push({ isCustom: isCustomModel, customModel: isCustomModel ? model : "" });
    return renderPage(context, "setup-wizard", {
      showStep2: true,
      providerIsOpenai: provider === "openai",
      providerIsAnthropic: provider === "anthropic",
      providerIsDeepseek: provider === "deepseek",
      secretKey, endpoint, modelOptions, thinkingEnabled, hasCustomModel: isCustomModel,
      reasoningEffortIsMax: reasoningEffort === "max",
    }, { title: "Setup Wizard — Symbio", standalone: true });
  }
  // Step 3: LLM preferences (language, personality, custom instruction)
  return renderPage(context, "setup-wizard", {
    showStep3: true,
    languageEn: llmLanguage === "en",
    languageDe: llmLanguage === "de",
    languageId: llmLanguage === "id",
    languageSu: llmLanguage === "su",
    personalityDefault: personality === "default",
    personalityProfessional: personality === "professional",
    personalityFriendly: personality === "friendly",
    personalityConcise: personality === "concise",
    personalityTechnical: personality === "technical",
    personalityEducational: personality === "educational",
    personalitySatirical: personality === "satirical",
    customInstruction,
  }, { title: "Setup Wizard — Symbio", standalone: true });
});

/** Processes the current wizard step form. */
protectedRoutes.post("/setup-wizard", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/dashboard");
  const auth = context.get("auth");
  const form = context.get("form");
  const step = parseInt(form.step || "1");
  if (step === 1) {
    const language = String(form.language || "en").trim();
    const validCodes = LANGUAGE_CHOICES.map((c) => c.code);
    if (validCodes.includes(language) && language !== auth.user.language) {
      auth.user.language = language;
      await auth.user.save();
    }
    // Save server-wide theme setting
    const theme = String(form.theme || "blue").trim();
    const validThemes = THEME_CHOICES.map((c) => c.code);
    if (validThemes.includes(theme)) {
      await models.Setting.upsert({ key: "theme", value: theme, updatedAt: new Date() });
    }
    await writeWizardState({ completed: false, step: 2 });
    return context.redirect("/setup-wizard");
  }
  if (step === 2) {
    const provider = String(form.provider || "deepseek").trim();
    const secretKey = String(form.secretKey || "").trim();
    const endpoint = String(form.endpoint || "").trim();
    const model = String(form.customModel || form.model || "").trim();
    const thinkingEnabled = form.thinkingEnabled === "1";
    const reasoningEffort = form.reasoningEffort === "max" ? "max" : "high";
    const value = JSON.stringify({ provider, secretKey, endpoint, model, thinkingEnabled, reasoningEffort });
    await models.Setting.upsert({ key: "llm_config", value, updatedAt: new Date() });
    await writeWizardState({ completed: false, step: 3 });
    return context.redirect("/setup-wizard?step=3");
  }
  if (step === 3) {
    const llmRow = await models.Setting.findByPk("llm_config");
    if (!llmRow) return context.redirect("/setup-wizard?step=2&error=configure-llm-first");
    let config = {};
    try { config = JSON.parse(llmRow.value); } catch {}
    config.language = form.llmLanguage || "en";
    config.personality = form.personality || "professional";
    config.customInstruction = String(form.customInstruction || "").trim();
    await models.Setting.upsert({ key: "llm_config", value: JSON.stringify(config), updatedAt: new Date() });
    await writeWizardState({ completed: true, step: 3 });
    return context.redirect("/dashboard");
  }
  return context.redirect("/setup-wizard");
});

/** Resets the setup wizard so the user can run it again from Settings. */
protectedRoutes.post("/setup-wizard/reset", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/dashboard");
  await writeWizardState({ completed: false, step: 1 });
  return context.redirect("/setup-wizard");
});

/** Sends a log analysis question to the configured LLM and renders the response. */
protectedRoutes.post("/ai/ask", requireCsrf, async (context) => {
  const form = context.get("form");
  const question = String(form.question || "").trim();
  let logContent = String(form.logContent || "").trim();
  const sourceUrl = String(form.sourceUrl || "").trim();
  const logName = String(form.logName || "Log").trim();
  const logType = String(form.logType || "").trim();
  const includeContext = form.includeContext !== "0";
  if (!question || !logContent) {
    return context.redirect(`${sourceUrl}?aiError=${encodeURIComponent("Question and log content are required.")}`);
  }
  const llmRow = await models.Setting.findByPk("llm_config");
  if (!llmRow) {
    return renderPage(context, "ai-response", {
      server: null, question, logName, sourceUrl, content: "", contentHtml: null, reasoningContent: null, usage: null,
      model: "", responseTimeMs: 0, requestText: "", historyId: null,
      error: "LLM is not configured. Go to Settings > LLM Integration to set up an API key.",
      showAskAgain: false,
    }, { title: "AI Analysis — Symbio" });
  }
  let config;
  try { config = JSON.parse(llmRow.value); } catch { config = null; }
  if (!config || !config.provider || !config.secretKey) {
    return renderPage(context, "ai-response", {
      server: null, question, logName, sourceUrl, content: "", contentHtml: null, reasoningContent: null, usage: null,
      model: "", responseTimeMs: 0, requestText: "", historyId: null,
      error: "LLM configuration is incomplete. Check Settings > LLM Integration.",
      showAskAgain: false,
    }, { title: "AI Analysis — Symbio" });
  }
  let contextStr = "";
  if (includeContext) {
    try {
      const [serverRow, statusRow, procResult, pkgResult] = await Promise.allSettled([
        models.Server.findOne({ where: { slug: "main-server" } }),
        models.ServerStatus.findOne({ order: [["observedAt", "DESC"]] }),
        fetchProcessList(), fetchInstalledPackages(),
      ]);
      const serverVal = serverRow.status === "fulfilled" && serverRow.value ? serverRow.value.toJSON() : null;
      const statusVal = statusRow.status === "fulfilled" ? statusRow.value : null;
      const procVal = procResult.status === "fulfilled" ? procResult.value : null;
      const pkgVal = pkgResult.status === "fulfilled" ? pkgResult.value : null;
      contextStr = buildAskContext(serverVal, statusVal, procVal, pkgVal, logType);
      logContent = contextStr + "\n\n--- LOG CONTENT BELOW ---\n\n" + logContent;
    } catch {}
  }
  const model = config.model || "default";
  const startTime = Date.now();
  const result = await askAI({
    provider: config.provider, apiKey: config.secretKey, endpoint: config.endpoint, model,
    logContent, question,
    thinkingEnabled: config.thinkingEnabled !== false,
    reasoningEffort: config.reasoningEffort || "high",
    language: config.language, personality: config.personality,
    customInstruction: config.customInstruction,
  });
  const responseTimeMs = Date.now() - startTime;
  if (result.usage) await accumulateUsage(result.usage, { model, source: "ai-ask" });
  const contentHtml = result.content ? renderMarkdown(result.content) : null;
  const requestText = `[SYSTEM PROMPT]\n${buildSystemPrompt()}\n\n${contextStr ? `[SERVER CONTEXT]\n${contextStr}\n\n` : ""}[LOG CONTENT]\n${logContent.slice(0, 3000)}${logContent.length > 3000 ? "\n... (truncated)" : ""}\n\n[QUESTION]\n${question}`;
  let historyId = null;
  if (result.content) {
    try {
      const record = await models.AIHistory.create({
        provider: config.provider, model, question, logContent: String(form.logContent || "").slice(0, 3000),
        context: contextStr || null, requestText, responseText: result.content || "",
        reasoningContent: result.reasoningContent || null, responseHtml: contentHtml,
        tokenInput: result.usage?.promptTokens || 0, tokenOutput: result.usage?.completionTokens || 0,
        tokenTotal: result.usage?.totalTokens || 0, responseTimeMs,
        logName, sourceUrl, logType: logType || null,
      });
      historyId = record.id;
    } catch {}
  }
  return renderPage(context, "ai-response", {
    server: null, question, logName, sourceUrl,
    content: result.content || "", contentHtml,
    reasoningContent: result.reasoningContent || null,
    usage: result.usage, model, responseTimeMs, requestText, historyId,
    error: result.error || "",
    showAskAgain: !result.error,
  }, { title: "AI Analysis — Symbio" });
});

/**
 * Global AI bar — accepts a question from the topbar input, gathers page-aware context
 * based on where the user submitted from, calls the LLM, and renders the response page.
 * This is the bruteforce "bolt AI onto everything" feature for maximum AI coatiness.
 */
protectedRoutes.post("/ai/bar", requireCsrf, async (context) => {
  const form = context.get("form");
  const question = String(form.question || "").trim();
  const sourcePage = String(form.sourcePage || "/dashboard");
  if (!question || question.length > 1000) {
    return context.redirect("/dashboard?ai_error=invalid");
  }
  const llmRow = await models.Setting.findByPk("llm_config");
  if (!llmRow) {
    return renderPage(context, "ai-response", {
      question, error: "LLM is not configured.", showAskAgain: false, content: "",
    }, { title: "AI Analysis — Symbio" });
  }
  let config;
  try { config = JSON.parse(llmRow.value); } catch { config = null; }
  if (!config?.secretKey || !config?.provider) {
    return renderPage(context, "ai-response", {
      question, error: "LLM configuration is incomplete.", showAskAgain: false, content: "",
    }, { title: "AI Analysis — Symbio" });
  }
  const [contextStr, label, logType] = await buildAiBarContext(sourcePage);
  const model = config.model || "default";
  const startTime = Date.now();
  const result = await askAI({
    provider: config.provider, apiKey: config.secretKey, endpoint: config.endpoint, model,
    logContent: contextStr, question,
    thinkingEnabled: config.thinkingEnabled !== false,
    reasoningEffort: config.reasoningEffort || "high",
    language: config.language, personality: config.personality,
    customInstruction: config.customInstruction,
  });
  const responseTimeMs = Date.now() - startTime;
  if (result.usage) await accumulateUsage(result.usage, { model, source: "ai-bar" });
  const contentHtml = result.content ? renderMarkdown(result.content) : null;
  const requestText = `[SYSTEM PROMPT]\n${buildSystemPrompt()}\n\n[DASHBOARD CONTEXT]\n${contextStr.slice(0, 3000)}\n\n[QUESTION]\n${question}`;
  let historyId = null;
  if (result.content) {
    try {
      const record = await models.AIHistory.create({
        provider: config.provider, model, question,
        logContent: contextStr.slice(0, 3000),
        context: label || null,
        requestText,
        responseText: result.content || "",
        reasoningContent: result.reasoningContent || null,
        responseHtml: contentHtml,
        tokenInput: result.usage?.promptTokens || 0,
        tokenOutput: result.usage?.completionTokens || 0,
        tokenTotal: result.usage?.totalTokens || 0,
        responseTimeMs,
        logName: label || sourcePage,
        sourceUrl: sourcePage,
        logType: logType || null,
      });
      historyId = record.id;
    } catch {}
  }
  return renderPage(context, "ai-response", {
    question,
    logName: label || sourcePage,
    sourceUrl: sourcePage,
    content: result.content || "", contentHtml,
    reasoningContent: result.reasoningContent || null,
    usage: result.usage, model, responseTimeMs, requestText, historyId,
    error: result.error || "",
    showAskAgain: !result.error,
  }, { title: "AI Analysis — Symbio" });
});

/** Symbio Intelligence root — redirects to command center by default. */
protectedRoutes.get("/ai", async (context) => {
  // Redirect superadmin to setup wizard if not completed
  if (isSuperadmin(context)) {
    const wizState = await readWizardState();
    if (!wizState.completed) return context.redirect("/setup-wizard");
  }
  return context.redirect("/ai/command-center");
});

/** AI History — tabs for Skill Runs (paginated, filterable) and AI Chat (paginated). */
protectedRoutes.get("/ai/history", async (context) => {
  const tab = context.req.query("tab") || "runs";
  const page = Math.max(1, parseInt(context.req.query("page")) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const skillFilter = context.req.query("skill") || "";
  const statusFilter = context.req.query("status") || "";
  const hasErrorFilter = context.req.query("hasError") === "1";
  const skills = await models.Skill.findAll({ attributes: ["id", "key", "name"] });
  const skillMap = {};
  const skillOptions = [];
  for (const s of skills) {
    skillMap[s.id] = s.name;
    skillOptions.push({ value: s.key, label: s.name, selected: s.key === skillFilter });
  }

  let runs = [], runsTotal = 0, chatEntries = [], chatTotal = 0;

  if (tab === "runs") {
    const where = {};
    if (skillFilter) {
      const matched = skills.find((s) => s.key === skillFilter);
      if (matched) where.skillId = matched.id;
    }
    if (statusFilter) where.status = statusFilter;
    if (hasErrorFilter) where.errorMessage = { [Op.ne]: null, [Op.ne]: "" };

    const { count, rows } = await models.SkillRun.findAndCountAll({
      where, order: [["createdAt", "DESC"]], limit, offset, raw: true,
    });
    runsTotal = count;
    runs = rows.map((r) => {
      const dur = r.startedAt && r.finishedAt
        ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + "s"
        : "—";
      return {
        id: r.id,
        skillName: skillMap[r.skillId] || "Unknown",
        trigger: r.trigger || "scheduled",
        status: r.status,
        summary: r.status === "failed" && r.errorMessage ? r.errorMessage.slice(0, 100) : (r.summary || "—"),
        startedAt: r.startedAt ? new Date(r.startedAt).toLocaleString() : "—",
        statusBadge: r.status === "completed" ? "text-bg-success" : r.status === "running" ? "text-bg-info" : r.status === "failed" ? "text-bg-danger" : "text-bg-secondary",
        statusLabel: r.status.charAt(0).toUpperCase() + r.status.slice(1),
        duration: dur,
        isFailed: r.status === "failed",
      };
    });
  } else {
    const { count, rows } = await models.AIHistory.findAndCountAll({
      order: [["createdAt", "DESC"]], limit, offset, raw: true,
    });
    chatTotal = count;
    chatEntries = rows.map((e) => ({
      id: e.id, question: e.question, model: e.model || "—", modelLogo: modelLogo(e.model),
      tokenTotal: e.tokenTotal, responseTimeMs: e.responseTimeMs,
      createdAt: new Date(e.createdAt).toLocaleString(),
      success: !!e.responseText,
    }));
  }

  const totalItems = tab === "runs" ? runsTotal : chatTotal;
  const totalPages = Math.ceil(totalItems / limit);
  // Build pagination: list of page numbers with active state
  const pagination = [];
  const maxVisible = 7;
  const startPage = Math.max(1, page - 3);
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  for (let p = startPage; p <= endPage; p++) pagination.push({ page: p, active: p === page });

  const buildPageUrl = (p) => {
    let url = `?tab=${tab}&page=${p}`;
    if (skillFilter) url += `&skill=${encodeURIComponent(skillFilter)}`;
    if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;
    if (hasErrorFilter) url += `&hasError=1`;
    return url;
  };

  return renderPage(context, "ai-history", {
    tabRuns: tab === "runs",
    tabChat: tab === "chat",
    skillFilter,
    statusFilter,
    hasErrorFilter,
    statusRunning: statusFilter === "running",
    statusCompleted: statusFilter === "completed",
    statusFailed: statusFilter === "failed",
    statusCancelled: statusFilter === "cancelled",
    skillOptions,
    runs,
    chatEntries,
    page,
    offset: offset + 1,
    limit: Math.min(offset + limit, totalItems),
    totalItems,
    totalPages,
    prevPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
    pagination,
    currentTab: tab,
    cleared: context.req.query("cleared") === "1",
  }, { title: "AI History — Symbio" });
});

/** Token Usage page — accumulated LLM token counts with per-skill breakdown, graph, and recent entries. */
protectedRoutes.get("/ai/usage", async (context) => {
  const usage = await readLlmUsage();
  const range = context.req.query("range") || "24h";
  // Determine time boundaries
  const now = new Date();
  const rangeMs = { "24h": 86_400_000, "7d": 604_800_000, "week": 604_800_000, "30d": 2_592_000_000, "month": 2_592_000_000 };
  const since = new Date(now.getTime() - (rangeMs[range] || rangeMs["24h"]));

  // Per-skill breakdown for the range
  const skillBreakdown = await models.TokenUsage.findAll({
    attributes: [
      "skillKey",
      [sequelize.fn("SUM", sequelize.col("total_tokens")), "total"],
      [sequelize.fn("SUM", sequelize.col("prompt_tokens")), "prompt"],
      [sequelize.fn("SUM", sequelize.col("completion_tokens")), "completion"],
      [sequelize.fn("COUNT", sequelize.col("id")), "calls"],
    ],
    where: { createdAt: { [Op.gte]: since } },
    group: ["skillKey"],
    raw: true,
    order: [[sequelize.literal("total"), "DESC"]],
  });

  // Daily bars — token totals per day for the last 30 days
  const dailyRaw = await models.TokenUsage.findAll({
    attributes: [
      [sequelize.fn("DATE", sequelize.col("created_at")), "day"],
      [sequelize.fn("SUM", sequelize.col("total_tokens")), "total"],
    ],
    where: { createdAt: { [Op.gte]: new Date(now.getTime() - 30 * 86_400_000) } },
    group: [sequelize.fn("DATE", sequelize.col("created_at"))],
    raw: true,
    order: [[sequelize.literal("day"), "ASC"]],
  });
  const dailyMap = {};
  for (const d of dailyRaw) dailyMap[d.day] = Number(d.total) || 0;
  // Build 30-day array with zero-fill for missing days
  const dailyBars = [];
  let maxDaily = 0;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const val = dailyMap[key] || 0;
    if (val > maxDaily) maxDaily = val;
    dailyBars.push({ label: key.slice(5), value: val });
  }
  // Compute bar heights as percentages
  for (const b of dailyBars) b.pct = maxDaily > 0 ? Math.round((b.value / maxDaily) * 100) : 0;

  // Recent entries with run context (last 50)
  const [recent] = await sequelize.query(`
    SELECT tu.id, tu.skill_key, tu.model, tu.prompt_tokens, tu.completion_tokens,
           tu.total_tokens, tu.source, tu.created_at,
           COALESCE(sr.summary, '') as run_description
    FROM token_usage tu
    LEFT JOIN skill_runs sr ON tu.skill_run_id = sr.id
    ORDER BY tu.created_at DESC
    LIMIT 50
  `);

  // Skill names lookup
  const skillRows = await models.Skill.findAll({ attributes: ["key", "name", "icon"] });
  const skillInfo = {};
  for (const s of skillRows) skillInfo[s.key] = { name: s.name, icon: s.icon };

  const rangeActive = (r) => range === r;

  return renderPage(context, "ai-usage", {
    usage, usageReset: context.req.query("usageReset") === "1",
    skillBreakdown: skillBreakdown.map((s) => ({
      key: s.skillKey || "chat",
      name: (s.skillKey ? (skillInfo[s.skillKey]?.name || s.skillKey) : "Chat / AI Assistant"),
      icon: s.skillKey ? (skillInfo[s.skillKey]?.icon || "fa-solid fa-gear") : "fa-solid fa-comment",
      total: Number(s.total) || 0,
      prompt: Number(s.prompt) || 0,
      completion: Number(s.completion) || 0,
      calls: Number(s.calls) || 0,
      pctOfTotal: usage.totalTokens > 0 ? Math.round((Number(s.total) / usage.totalTokens) * 100) : 0,
    })),
    dailyBars,
    maxDaily,
    recent: recent.map((r) => ({
      id: r.id,
      skillName: r.skill_key ? (skillInfo[r.skill_key]?.name || r.skill_key) : "Chat",
      model: r.model || "—", modelLogo: modelLogo(r.model),
      prompt: r.prompt_tokens || 0,
      completion: r.completion_tokens || 0,
      total: r.total_tokens || 0,
      source: r.source,
      description: r.run_description || (r.source === "chat" ? "AI Chat / Clarify" : "Data collection — no details"),
      createdAt: r.created_at ? new Date(r.created_at).toLocaleString() : "—",
    })),
    range24h: rangeActive("24h"),
    range7d: rangeActive("7d"),
    rangeWeek: rangeActive("week"),
    range30d: rangeActive("30d"),
  }, { title: "Token Usage — Symbio" });
});

// ============================================================================
// Alert System — threshold-based resource monitoring with notification dispatch
// ============================================================================

/** Maps resource+metricField to human display label for the UI. */
const alertResourceLabel = (resource, metricField) => {
  const map = {
    cpu_cpuPercent: "CPU", cpu_cpuIowaitPercent: "I/O Wait",
    memory_memoryPercent: "Memory", swap_swapPercent: "Swap",
    disk_diskPercent: "Disk", load_load1: "Load (1m)", load_load5: "Load (5m)", load_load15: "Load (15m)",
    network_networkRxBytesPerSec: "Download", network_networkTxBytesPerSec: "Upload",
    application_status: "Application Status", service_status: "Service Status",
  };
  return map[`${resource}_${metricField}`] || `${resource} ${metricField}`;
};

/** Formats a metric value for display in tables. */
const formatMetricDisplay = (field, value) => {
  if (value == null) return "—";
  if (field?.includes?.("network")) return `${(Number(value) / 1048576).toFixed(2)} MB/s`;
  if (field?.includes?.("Percent") || field?.includes?.("percent")) return `${Number(value).toFixed(1)}%`;
  if (field?.startsWith?.("load")) return Number(value).toFixed(2);
  return String(value);
};

/** Formats duration in seconds to human display. */
const formatDurationDisplay = (seconds) => {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

/** Returns Bootstrap badge base class name for alert severity level (without text-bg- prefix). */
const severityClass = (severity) => {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
};

/** Returns metric options grouped by resource for the rule form dropdown. */
const metricOptionsForResource = (resource) => {
  const options = {
    cpu: [{ value: "cpuPercent", label: "CPU Usage" }, { value: "cpuIowaitPercent", label: "CPU I/O Wait" }],
    memory: [{ value: "memoryPercent", label: "Memory Usage" }],
    swap: [{ value: "swapPercent", label: "Swap Usage" }],
    disk: [{ value: "diskPercent", label: "Disk Usage" }],
    load: [{ value: "load1", label: "Load (1 min)" }, { value: "load5", label: "Load (5 min)" }, { value: "load15", label: "Load (15 min)" }],
    network: [{ value: "networkRxBytesPerSec", label: "Download Throughput" }, { value: "networkTxBytesPerSec", label: "Upload Throughput" }],
    application: [{ value: "status", label: "Status Check" }],
    service: [{ value: "status", label: "Status Check" }],
  };
  return options[resource] || [];
};

/** Decorates a rule and its metric options for the rule form template. */
const decorateRuleForm = (rule) => {
  const resource = rule.resource || "cpu";
  const allMetrics = {
    cpu: metricOptionsForResource("cpu"),
    memory: metricOptionsForResource("memory"),
    swap: metricOptionsForResource("swap"),
    disk: metricOptionsForResource("disk"),
    load: metricOptionsForResource("load"),
    network: metricOptionsForResource("network"),
    application: metricOptionsForResource("application"),
    service: metricOptionsForResource("service"),
  };
  const selectedMetric = rule.metricField || (allMetrics[resource][0]?.value || "");

  const decorateGroup = (opts, group) => opts.map(o => ({
    ...o, selected: o.value === selectedMetric && group === resource,
  }));

  const isNumeric = resource !== "application" && resource !== "service";
  let statusChecked = {};
  try { const sm = JSON.parse(rule.statusMatch || "[]"); for (const s of sm) statusChecked[s] = true; } catch {}

  return {
    ...rule,
    // Convert bytes/sec to MB/s for display in the form
    thresholdValue: resource === "network" ? (rule.thresholdValue / 1048576).toFixed(2) : rule.thresholdValue,
    isNumeric,
    resourceCpu: resource === "cpu",
    resourceMemory: resource === "memory",
    resourceSwap: resource === "swap",
    resourceDisk: resource === "disk",
    resourceLoad: resource === "load",
    resourceNetwork: resource === "network",
    resourceApplication: resource === "application",
    resourceService: resource === "service",
    severityWarning: rule.severity !== "critical" && rule.severity !== "info",
    severityCritical: rule.severity === "critical",
    severityInfo: rule.severity === "info",
    enabledYes: rule.enabled !== false,
    enabledNo: rule.enabled === false,
    operatorGt: rule.operator !== "lt",
    metricsCpu: decorateGroup(allMetrics.cpu, "cpu"),
    metricsMemory: decorateGroup(allMetrics.memory, "memory"),
    metricsSwap: decorateGroup(allMetrics.swap, "swap"),
    metricsDisk: decorateGroup(allMetrics.disk, "disk"),
    metricsLoad: decorateGroup(allMetrics.load, "load"),
    metricsNetwork: decorateGroup(allMetrics.network, "network"),
    metricsApplication: decorateGroup(allMetrics.application, "application"),
    metricsService: decorateGroup(allMetrics.service, "service"),
    diagnosticEnabled: rule.diagnosticEnabled !== false,
    targetId: rule.targetId || "",
    statusCheckedDown: !!statusChecked.down,
    statusCheckedSlow: !!statusChecked.slow,
    statusCheckedDegraded: !!statusChecked.degraded,
    statusCheckedUnavailable: !!statusChecked.unavailable,
    statusCheckedNotDetected: !!statusChecked.not_detected,
    healSkillKey: rule.healSkillKey || "",
    hasHeal: rule.healSkillKey === "storage-maid",
  };
};

/** Decorates an alert event for display in the alerts list. */
const decorateAlertEvent = (event, ruleName) => {
  const diag = parseJson(event.diagnosticJson, null);
  const rssFormatter = (rss) => (rss / 1048576).toFixed(1);
  const isStatusType = event.resource === "application" || event.resource === "service";
  const statusMatchList = parseJson(event.status_match, []);
  const isFiring = event.status === "firing";
  return {
    id: event.id,
    ruleId: event.ruleId,
    ruleName: ruleName || "—",
    resourceLabel: isStatusType
      ? `${event.resource === "application" ? "App" : "Service"} Status`
      : alertResourceLabel(event.resource, event.metricField),
    metricDisplay: isStatusType
      ? (isFiring ? (statusMatchList.join(" or ") || "?") : "OK")
      : formatMetricDisplay(event.metricField, event.metricValue),
    thresholdDisplay: isStatusType
      ? (isFiring ? `status in [${statusMatchList.join(", ")}]` : "Normal")
      : formatMetricDisplay(event.metricField, event.thresholdValue),
    operatorLabel: isStatusType ? "=" : (event.operator === "gt" ? ">" : "<"),
    triggeredAt: event.triggeredAt ? new Date(event.triggeredAt).toLocaleString() : "—",
    resolvedAt: event.resolvedAt ? new Date(event.resolvedAt).toLocaleString() : "—",
    severityClass: event.severity ? severityClass(event.severity) : "warning",
    isFiring,
    isResolved: event.status === "resolved",
    isAcknowledged: event.status === "acknowledged",
    hasDiagnostic: !isStatusType && !!diag && (diag.topCpu?.length > 0 || diag.topMem?.length > 0),
    diagTopCpu: diag?.topCpu?.map(p => ({ ...p, rssMb: p.rss ? rssFormatter(p.rss) : "?" })),
    diagTopMem: diag?.topMem?.map(p => ({ ...p, rssMb: rssFormatter(p.rss) })),
    targetName: event.target_name || "",
  };
};

// ---- Alert Routes ----

/** Main alert management page: rules, firing events, recent history. */
protectedRoutes.get("/alerts", async (context) => {
  const server = await models.Server.findOne({ where: { slug: "main-server" } });
  const serverId = server?.id || 1;
  const [rules, firingEvents, recentEvents, resolved24hCount, channelTotal, channelEnabled] = await Promise.all([
    models.AlertRule.findAll({ where: { serverId }, order: [["resource", "ASC"], ["name", "ASC"]], raw: true }),
    sequelize.query(`
      SELECT ae.*, ar.name as rule_name, ar.resource, ar.metric_field, ar.severity, ar.target_id, ar.status_match
      FROM alert_events ae
      JOIN alert_rules ar ON ae.rule_id = ar.id
      WHERE ae.status = 'firing'
      ORDER BY ae.triggered_at DESC
      LIMIT 20
    `, { type: QueryTypes.SELECT }),
    sequelize.query(`
      SELECT ae.*, ar.name as rule_name, ar.resource, ar.metric_field, ar.severity, ar.target_id, ar.status_match
      FROM alert_events ae
      JOIN alert_rules ar ON ae.rule_id = ar.id
      ORDER BY ae.triggered_at DESC
      LIMIT 50
    `, { type: QueryTypes.SELECT }),
    models.AlertEvent.count({ where: { resolvedAt: { [Op.gte]: new Date(Date.now() - 86400000) } } }),
    models.NotificationChannel.count(),
    models.NotificationChannel.count({ where: { enabled: true } }),
  ]);

  const statsTotalRules = rules.length;
  const statsEnabledRules = rules.filter(r => r.enabled !== false).length;
  const statsFiringCount = firingEvents.length;
  const statsResolved24h = resolved24hCount;

  const rulesDecorated = rules.map(r => {
    const isStatusType = r.resource === "application" || r.resource === "service";
    const statusList = parseJson(r.statusMatch, []);
    return {
      ...r,
      resourceLabel: isStatusType
        ? `${r.resource === "application" ? "App" : "Service"}: ${r.targetId || "?"}`
        : alertResourceLabel(r.resource, r.metricField),
      operatorLabel: isStatusType ? "=" : (r.operator === "gt" ? ">" : "<"),
      thresholdDisplay: isStatusType ? `[${statusList.join(", ")}]` : formatMetricDisplay(r.metricField, r.thresholdValue),
      durationDisplay: formatDurationDisplay(r.durationSeconds),
      severityClass: severityClass(r.severity),
      severityLabel: r.severity,
      enabled: r.enabled !== false,
    };
  });

  const firingDecorated = firingEvents.map(e => decorateAlertEvent({ ...e, status: "firing", severity: e.severity }, e.rule_name));
  const recentDecorated = recentEvents.map(e => decorateAlertEvent(e, e.rule_name));

  return renderPage(context, "alerts", {
    rules: rulesDecorated,
    firingEvents: firingDecorated,
    recentEvents: recentDecorated,
    statsTotalRules,
    statsEnabledRules,
    statsFiringCount,
    statsResolved24h,
    statsChannelCount: channelTotal,
    statsChannelEnabled: channelEnabled,
    saved: context.req.query("saved") === "1",
    error: context.req.query("error") || "",
  }, { titleKey: "alerts.title" });
});

/** Create rule form (GET). */
protectedRoutes.get("/alerts/rules/create", async (context) => {
  const [channels, applications, services] = await Promise.all([
    models.NotificationChannel.findAll({ where: { enabled: true }, raw: true }),
    models.Application.findAll({ where: { deletedAt: null }, order: [["name", "ASC"]], raw: true }),
    models.ServerService.findAll({ order: [["type", "ASC"]], raw: true }),
  ]);
  const rule = decorateRuleForm({
    resource: "cpu", metricField: "cpuPercent", operator: "gt",
    thresholdValue: 90, durationSeconds: 120, cooldownSeconds: 600,
    severity: "warning", enabled: true, diagnosticEnabled: true,
  });
  return renderPage(context, "alert-rule-form", {
    ...rule,
    rule,
    isEdit: false,
    formAction: "/alerts/rules/create",
    channels: channels.map(c => ({ ...c, checked: false })),
    applications: applications.map(a => ({ ...a, selected: false })),
    services: services.map(s => ({ ...s, selected: false })),
    healSkillExists: true,
    error: context.req.query("error") || "",
  }, { titleKey: "alerts.createRule" });
});

/** Save new rule (POST). */
protectedRoutes.post("/alerts/rules/create", requireCsrf, async (context) => {
  const form = context.get("form");
  try {
    const resource = String(form.resource || "cpu");
    const isStatusType = resource === "application" || resource === "service";
    if (!isStatusType && parseFloat(form.thresholdValue) < 0) throw new Error("Threshold value must be 0 or greater.");
    if (parseInt(form.durationSeconds) < 10) throw new Error("Duration must be at least 10 seconds.");
    const channelIds = [];
    const allChannels = await models.NotificationChannel.findAll({ raw: true });
    for (const ch of allChannels) {
      if (form[`channel_${ch.id}`] === "1") channelIds.push(ch.id);
    }
    // Collect status_match checkboxes for app/service rules
    const statusMatch = [];
    if (isStatusType) {
      if (resource === "application") {
        if (form.status_slow === "1") statusMatch.push("slow");
        if (form.status_down === "1") statusMatch.push("down");
      } else {
        if (form.status_degraded === "1") statusMatch.push("degraded");
        if (form.status_unavailable === "1") statusMatch.push("unavailable");
        if (form.status_not_detected === "1") statusMatch.push("not_detected");
      }
    }
    const mainServer = await models.Server.findOne({ where: { slug: "main-server" } });
    await models.AlertRule.create({
      serverId: mainServer?.id || 1,
      name: String(form.name || "").trim().slice(0, 128),
      resource,
      metricField: isStatusType ? "status" : (String(form.metricField || "cpuPercent")),
      operator: isStatusType ? "eq" : (String(form.operator || "gt")),
      thresholdValue: isStatusType ? 0 : (resource === "network" ? (parseFloat(form.thresholdValue) || 0) * 1048576 : (parseFloat(form.thresholdValue) || 0)),
      durationSeconds: parseInt(form.durationSeconds) || 120,
      cooldownSeconds: parseInt(form.cooldownSeconds) || 600,
      severity: String(form.severity || "warning"),
      enabled: form.enabled !== "0",
      notifyChannels: JSON.stringify(channelIds),
      diagnosticEnabled: isStatusType || resource === "network" ? false : (form.diagnosticEnabled === "1"),
      targetId: isStatusType ? (parseInt(form.targetId) || null) : null,
      statusMatch: JSON.stringify(statusMatch),
      healSkillKey: String(form.healSkillKey || "").trim() || null,
    });
    return context.redirect("/alerts?saved=1");
  } catch (error) {
    return context.redirect(`/alerts/rules/create?error=${encodeURIComponent(error.message)}`);
  }
});

/** Edit rule form (GET). */
protectedRoutes.get("/alerts/rules/:id/edit", async (context) => {
  const rule = await models.AlertRule.findByPk(context.req.param("id"), { raw: true });
  if (!rule) return context.notFound();

  const [channels, applications, services] = await Promise.all([
    models.NotificationChannel.findAll({ raw: true }),
    models.Application.findAll({ where: { deletedAt: null }, order: [["name", "ASC"]], raw: true }),
    models.ServerService.findAll({ order: [["type", "ASC"]], raw: true }),
  ]);
  let selectedIds = [];
  try { selectedIds = JSON.parse(rule.notifyChannels || "[]"); } catch {}

  const decorated = decorateRuleForm(rule);
  return renderPage(context, "alert-rule-form", {
    ...decorated,
    rule: decorated,
    isEdit: true,
    formAction: `/alerts/rules/${rule.id}/edit`,
    channels: channels.map(c => ({ ...c, checked: selectedIds.includes(c.id) })),
    applications: applications.map(a => ({ ...a, selected: a.id === rule.targetId })),
    services: services.map(s => ({ ...s, selected: s.id === rule.targetId })),
    healSkillExists: true,
    error: context.req.query("error") || "",
  }, { titleKey: "alerts.editRule" });
});

/** Save edited rule (POST). */
protectedRoutes.post("/alerts/rules/:id/edit", requireCsrf, async (context) => {
  const rule = await models.AlertRule.findByPk(context.req.param("id"));
  if (!rule) return context.notFound();
  const form = context.get("form");
  try {
    const resource = String(form.resource || "cpu");
    const isStatusType = resource === "application" || resource === "service";
    if (!isStatusType && parseFloat(form.thresholdValue) < 0) throw new Error("Threshold value must be 0 or greater.");
    if (parseInt(form.durationSeconds) < 10) throw new Error("Duration must be at least 10 seconds.");
    const channelIds = [];
    const allChannels = await models.NotificationChannel.findAll({ raw: true });
    for (const ch of allChannels) {
      if (form[`channel_${ch.id}`] === "1") channelIds.push(ch.id);
    }
    const statusMatch = [];
    if (isStatusType) {
      if (resource === "application") {
        if (form.status_slow === "1") statusMatch.push("slow");
        if (form.status_down === "1") statusMatch.push("down");
      } else {
        if (form.status_degraded === "1") statusMatch.push("degraded");
        if (form.status_unavailable === "1") statusMatch.push("unavailable");
        if (form.status_not_detected === "1") statusMatch.push("not_detected");
      }
    }
    await rule.update({
      name: String(form.name || "").trim().slice(0, 128),
      resource,
      metricField: isStatusType ? "status" : (String(form.metricField || "cpuPercent")),
      operator: isStatusType ? "eq" : (String(form.operator || "gt")),
      thresholdValue: isStatusType ? 0 : (resource === "network" ? (parseFloat(form.thresholdValue) || 0) * 1048576 : (parseFloat(form.thresholdValue) || 0)),
      durationSeconds: parseInt(form.durationSeconds) || 120,
      cooldownSeconds: parseInt(form.cooldownSeconds) || 600,
      severity: String(form.severity || "warning"),
      enabled: form.enabled !== "0",
      notifyChannels: JSON.stringify(channelIds),
      diagnosticEnabled: isStatusType || resource === "network" ? false : (form.diagnosticEnabled === "1"),
      targetId: isStatusType ? (parseInt(form.targetId) || null) : null,
      statusMatch: JSON.stringify(statusMatch),
      healSkillKey: String(form.healSkillKey || "").trim() || null,
    });
    return context.redirect("/alerts?saved=1");
  } catch (error) {
    return context.redirect(`/alerts/rules/${rule.id}/edit?error=${encodeURIComponent(error.message)}`);
  }
});

/** Delete a rule. */
protectedRoutes.post("/alerts/rules/:id/delete", requireCsrf, async (context) => {
  const rule = await models.AlertRule.findByPk(context.req.param("id"));
  if (!rule) return context.notFound();
  await rule.destroy();
  return context.redirect("/alerts?saved=1");
});

/** Toggle rule enabled/disabled. */
protectedRoutes.post("/alerts/rules/:id/toggle", requireCsrf, async (context) => {
  const rule = await models.AlertRule.findByPk(context.req.param("id"));
  if (!rule) return context.notFound();
  await rule.update({ enabled: !rule.enabled });
  return context.redirect("/alerts?saved=1");
});

/** Acknowledge a firing alert event. */
protectedRoutes.post("/alerts/events/:id/acknowledge", requireCsrf, async (context) => {
  const auth = context.get("auth");
  const event = await models.AlertEvent.findByPk(context.req.param("id"));
  if (!event) return context.notFound();
  await event.update({ status: "acknowledged", acknowledgedBy: auth.user.id, acknowledgedAt: new Date() });
  return context.redirect("/alerts");
});

// ---- Settings: Messaging Integration ----

/** Show the add channel form (standalone page). */
protectedRoutes.get("/settings/messaging/channel/create", requireAuth, async (context) => {
  return renderPage(context, "messaging-channel-form", {
    editing: false,
    channel: { name: "", type: "slack", enabled: true, config: {}, isSlack: true },
    error: context.req.query("error") || "",
  }, { title: "Add Channel — Symbio" });
});

/** Show the edit channel form (standalone page). */
protectedRoutes.get("/settings/messaging/channel/:id/edit", requireAuth, async (context) => {
  const ch = await models.NotificationChannel.findByPk(context.req.param("id"), { raw: true });
  if (!ch) return context.notFound();
  const config = parseJson(ch.config, {});
  return renderPage(context, "messaging-channel-form", {
    editing: true,
    channel: { id: ch.id, name: ch.name, type: ch.type, enabled: ch.enabled, config, isSlack: ch.type === "slack" },
    error: context.req.query("error") || "",
  }, { title: "Edit Channel — Symbio" });
});

/** Save a notification channel (create or update). */
protectedRoutes.post("/settings/messaging/channel/save", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  const form = context.get("form");
  try {
    const channelId = form.id ? parseInt(form.id) : null;
    const config = {
      webhook_url: String(form.webhookUrl || "").trim(),
      slack_channel: String(form.slackChannel || "").trim(),
      slack_username: String(form.slackUsername || "").trim(),
      slack_icon_emoji: String(form.slackIconEmoji || "").trim(),
    };
    if (channelId) {
      const ch = await models.NotificationChannel.findByPk(channelId);
      if (!ch) throw new Error("Channel not found.");
      await ch.update({
        name: String(form.name || "").trim().slice(0, 128),
        type: String(form.type || "slack"),
        enabled: form.enabled === "1",
        config: JSON.stringify(config),
      });
    } else {
      await models.NotificationChannel.create({
        name: String(form.name || "").trim().slice(0, 128),
        type: String(form.type || "slack"),
        enabled: form.enabled === "1",
        config: JSON.stringify(config),
      });
    }
    return context.redirect("/settings?tab=messaging&saved=1");
  } catch (error) {
    return context.redirect(`/settings?tab=messaging&error=${encodeURIComponent(error.message)}`);
  }
});

/** Delete a notification channel. */
protectedRoutes.post("/settings/messaging/channel/:id/delete", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  const ch = await models.NotificationChannel.findByPk(context.req.param("id"));
  if (!ch) return context.notFound();
  await ch.destroy();
  return context.redirect("/settings?tab=messaging&saved=1");
});

/** Send a test notification to a channel. */
protectedRoutes.post("/settings/messaging/channel/:id/test", requireCsrf, async (context) => {
  if (!isSuperadmin(context)) return context.redirect("/settings");
  const ch = await models.NotificationChannel.findByPk(context.req.param("id"));
  if (!ch) return context.notFound();
  const { testChannel } = await import("../services/notifications/index.js");
  const result = await testChannel(ch);
  const param = result.ok ? "saved=1" : `error=${encodeURIComponent(result.error || "Test failed")}`;
  return context.redirect(`/settings?tab=messaging&${param}`);
});

/** Command Center — main Symbio Intelligence dashboard showing skill status and activity. */
protectedRoutes.get("/ai/command-center", async (context) => {
  const skills = await models.Skill.findAll({ order: [["id", "ASC"]] });
  const llmNotConfigured = !(await isLlmConfigured());
  const [recentRuns, pendingActions] = await Promise.all([
    models.SkillRun.findAll({ order: [["createdAt", "DESC"]], limit: 30, raw: true }),
    loadPendingActions(),
  ]);
  const skillMap = {};
  for (const s of skills) skillMap[s.id] = s.name;
  // Get currently running tasks from the in-memory scheduler state
  let runningTasks = [];
  try {
    const { getRunningTasks } = await import("../services/skills/scheduler.js");
    runningTasks = getRunningTasks();
  } catch {}
  // Build skill cards with their last run info
  const skillCards = [];
  for (const s of skills) {
    const lastRun = recentRuns.find((r) => r.skillId === s.id && r.status !== "running");
    const hasRecentError = recentRuns.some((r) => r.skillId === s.id && r.status === "failed");
    skillCards.push({
      key: s.key, name: s.name, description: s.description, icon: s.icon,
      skillIconImg: !s.icon.startsWith("fa-"),
      isRunning: runningTasks.some((t) => t.skillKey === s.key),
      hasError: hasRecentError,
      enabled: s.enabled,
      lastRunAt: lastRun?.startedAt ? new Date(lastRun.startedAt).toLocaleString() : null,
      summary: lastRun?.status === "failed" && lastRun?.errorMessage ? lastRun.errorMessage.slice(0, 80) : (lastRun?.summary || null),
    });
  }
  // Map status to badge class and label
  const statusBadge = (status) => {
    if (status === "completed") return "text-bg-success";
    if (status === "running") return "text-bg-info";
    if (status === "failed") return "text-bg-danger";
    return "text-bg-secondary";
  };
  // Phase badge class for running task display
  const phaseBadge = (phase) => {
    if (phase === "collecting" || phase === "filtering") return "text-bg-info";
    if (phase === "analyzing") return "text-bg-warning";
    if (phase === "reporting") return "text-bg-success";
    return "text-bg-secondary";
  };
  return renderPage(context, "ai-command-center", {
    llmNotConfigured,
    runStarted: context.req.query("run") === "started",
    runFailed: context.req.query("run") === "failed",
    runError: context.req.query("error") || "",
    stopped: context.req.query("stopped") === "1",
    stopFailed: context.req.query("stop") === "failed",
    skills: skillCards,
    hasRunningTasks: runningTasks.length > 0,
    runningTasks: runningTasks.map((t) => ({
      skillKey: t.skillKey,
      skillName: skillMap[t.skillKey] || t.skillKey,
      phase: t.phase,
      detail: t.detail,
      phaseBadge: phaseBadge(t.phase),
      duration: t.duration,
      startedAt: t.startedAt ? new Date(t.startedAt).toLocaleString() : "—",
    })),
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      skillName: skillMap[r.skillId] || "Unknown",
      summary: r.status === "failed" && r.errorMessage ? r.errorMessage.slice(0, 100) : (r.summary || "—"),
      status: r.status,
      startedAt: r.startedAt ? new Date(r.startedAt).toLocaleString() : "—",
      statusBadge: statusBadge(r.status),
      isRunning: r.status === "running",
      isCompleted: r.status === "completed",
      isFailed: r.status === "failed",
      hasError: !!r.errorMessage,
      errorMessage: r.errorMessage ? r.errorMessage.slice(0, 200) : "",
    })),
    pendingActions: pendingActions.slice(0, 5),
    hasPendingActions: pendingActions.length > 0,
  }, { title: "Command Center — Symbio" });
});

/** Manually triggers a skill run. */
protectedRoutes.post("/ai/command-center/run/:key", requireCsrf, async (context) => {
  const skillKey = context.req.param("key");
  try {
    const { runNow } = await import("../services/skills/scheduler.js");
    await runNow(skillKey);
    return context.redirect("/ai/command-center?run=started");
  } catch (error) {
    return context.redirect(`/ai/command-center?run=failed&error=${encodeURIComponent(error.message.slice(0, 100))}`);
  }
});

/** Force-stops a running skill at the next phase boundary. */
protectedRoutes.post("/ai/command-center/stop/:key", requireCsrf, async (context) => {
  const skillKey = context.req.param("key");
  try {
    const { killSkill } = await import("../services/skills/scheduler.js");
    await killSkill(skillKey);
    return context.redirect("/ai/command-center?stopped=1");
  } catch (error) {
    return context.redirect(`/ai/command-center?stop=failed&error=${encodeURIComponent(error.message.slice(0, 100))}`);
  }
});

/** Skill settings page — per-skill configuration, memory, enable/disable. */
protectedRoutes.get("/ai/command-center/:key/settings", async (context) => {
  const skill = await models.Skill.findOne({ where: { key: context.req.param("key") } });
  if (!skill) return context.notFound();
  const config = parseConfig(skill.config || "{}");
  const categories = [
    { value: "kernel", label: "Kernel", selected: config.categories?.includes("kernel") },
    { value: "nginx", label: "Nginx", selected: config.categories?.includes("nginx") },
    { value: "apache", label: "Apache", selected: config.categories?.includes("apache") },
    { value: "mysql", label: "MySQL", selected: config.categories?.includes("mysql") },
    { value: "postgresql", label: "PostgreSQL", selected: config.categories?.includes("postgresql") },
    { value: "redis", label: "Redis", selected: config.categories?.includes("redis") },
    { value: "php", label: "PHP", selected: config.categories?.includes("php") },
    { value: "docker", label: "Docker", selected: config.categories?.includes("docker") },
    { value: "system", label: "System", selected: config.categories?.includes("system") },
  ];
  return renderPage(context, "skill-settings", {
    skillKey: skill.key, skillName: skill.name, icon: skill.icon, description: skill.description,
    enabled: skill.enabled, memory: skill.memory || "",
    config: decorateConfig(skill.key, config),
    showStorageMaid: skill.key === "storage-maid",
    showUptimePolice: skill.key === "uptime-police",
    showErrorFinder: skill.key === "error-finder",
    showPackageUpdater: skill.key === "package-updater",
    showOptimizer: skill.key === "optimizer",
    showSusFinder: skill.key === "sus-finder",
    categoryOptions: categories,
    saved: context.req.query("saved") === "1",
  }, { title: `${skill.name} Settings — Symbio` });
});

/** Saves skill settings (config + memory + enabled). */
protectedRoutes.post("/ai/command-center/:key/settings", requireCsrf, async (context) => {
  const skill = await models.Skill.findOne({ where: { key: context.req.param("key") } });
  if (!skill) return context.notFound();
  const form = context.get("form");
  const config = buildConfig(skill.key, form);
  const memory = String(form.memory || "").trim();
  const enabled = form.enabled === "1";
  skill.config = JSON.stringify(config);
  skill.memory = memory;
  skill.enabled = enabled;
  await skill.save();
  const { refreshSkill } = await import("../services/skills/scheduler.js");
  refreshSkill(skill.key).catch(() => {});
  return context.redirect(`/ai/command-center/${skill.key}/settings?saved=1`);
});

/** Toggles a skill's enabled state from the Command Center. */
protectedRoutes.post("/ai/command-center/:key/toggle", requireCsrf, async (context) => {
  const skill = await models.Skill.findOne({ where: { key: context.req.param("key") } });
  if (!skill) return context.notFound();
  skill.enabled = !skill.enabled;
  await skill.save();
  const { refreshSkill } = await import("../services/skills/scheduler.js");
  refreshSkill(skill.key).catch(() => {});
  return context.redirect("/ai/command-center");
});

/** Pending Actions page — browse and manage all skill actions requiring approval. */
protectedRoutes.get("/ai/actions", async (context) => {
  const pendingActions = await loadPendingActions();
  const page = Math.max(1, parseInt(context.req.query("page")) || 1);
  const perPage = 50;

  // Count total history rows for pagination
  const [[{ total }]] = await sequelize.query(`
    SELECT COUNT(*) as total FROM skill_actions
    WHERE status IN ('executed','rejected','done','acknowledged')
  `);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const offset = (page - 1) * perPage;

  const [history] = await sequelize.query(`
    SELECT sa.*, s.name as skill_name, s.icon as skill_icon, s.key as skill_key,
           sf.title as finding_title, sf.description as finding_description
    FROM skill_actions sa
    JOIN skill_runs sr ON sa.skill_run_id = sr.id
    JOIN skills s ON sr.skill_id = s.id
    LEFT JOIN skill_findings sf ON sa.finding_id = sf.id
    WHERE sa.status IN ('executed','rejected','done','acknowledged')
    ORDER BY sa.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `);
  return renderPage(context, "ai-actions", {
    pendingActions, pendingCount: pendingActions.length,
    dismissAll: pendingActions.length >= 2,
    history: history.map((a) => ({
      ...formatAction(a),
      statusBadge: a.status === "executed" ? "text-bg-success" : a.status === "rejected" ? "text-bg-secondary" : a.status === "acknowledged" ? "text-bg-info" : "text-bg-info",
    })),
    approved: context.req.query("approved") === "1",
    rejected: context.req.query("rejected") === "1",
    markedDone: context.req.query("done") === "1",
    acknowledged: context.req.query("acknowledged") === "1",
    handled: context.req.query("handled") === "1",
    // Pagination
    page, totalPages, hasPrev: page > 1, hasNext: page < totalPages,
    prevPage: page - 1, nextPage: page + 1,
    historyCount: history.length,
  }, { title: "Pending Actions — Symbio" });
});

/** Action detail page — shows full proof (before/after/diff), parameters, and metadata. */
protectedRoutes.get("/ai/actions/:id", async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"), { raw: true });
  if (!action) return context.notFound();
  const finding = action.findingId ? await models.SkillFinding.findByPk(action.findingId, { raw: true }) : null;
  const run = await models.SkillRun.findByPk(action.skillRunId, { raw: true });
  const skill = run ? await models.Skill.findByPk(run.skillId, { raw: true }) : null;

  let result = {};
  let params = {};
  try { result = JSON.parse(action.result || "{}"); } catch {}
  try { params = JSON.parse(action.parameters || "{}"); } catch {}

  const hasProof = !!(result.beforeSummary && result.afterSummary);
  const skillName = skill?.name || "Unknown";
  const skillIcon = skill?.icon || "fa-solid fa-gear";
  const skillIconImg = skill?.icon && !skill.icon.startsWith("fa-");
  const created = action.created_at || action.createdAt;
  const executedAt = action.executed_at || action.executedAt;

  const statusBadge = action.status === "executed" ? "text-bg-success"
    : action.status === "rejected" ? "text-bg-secondary"
    : action.status === "acknowledged" ? "text-bg-info"
    : "text-bg-info";

  return renderPage(context, "ai-action-detail", {
    actionId: action.id,
    actionType: action.action_type || action.actionType,
    actionTarget: action.target || "",
    status: action.status,
    statusBadge,
    skillName, skillIcon, skillIconImg,
    findingTitle: finding?.title || "",
    findingDesc: finding?.description || "",
    findingSeverity: finding?.severity || "",
    findingPattern: finding?.pattern || "",
    severityBadge: finding?.severity === "critical" ? "text-bg-danger" : finding?.severity === "warning" ? "text-bg-warning" : "text-bg-info",
    hasProof,
    beforeSummary: result.beforeSummary || "",
    afterSummary: result.afterSummary || "",
    diff: result.diff || "",
    error: result.error || "",
    paramsJson: Object.keys(params).length ? JSON.stringify(params, null, 2) : null,
    createdAt: created ? new Date(created).toLocaleString() : "—",
    executedAt: executedAt ? new Date(executedAt).toLocaleString() : null,
    approvedBy: action.approved_by || action.approvedBy || null,
  }, { title: "Action Detail — Symbio" });
});

/**
 * Execution Request confirmation page — shows exact commands, AI explanation,
 * risk level, and affected systems before the user confirms execution.
 * Maximum user assurance — second layer of hallucination protection.
 */
protectedRoutes.get("/ai/actions/:id/execute", async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action) return context.redirect("/ai/actions");

  // Check if this is an executable skill
  const run = await models.SkillRun.findByPk(action.skillRunId, { raw: true });
  const skill = run ? await models.Skill.findByPk(run.skillId, { raw: true }) : null;
  const skillKey = skill?.key;
  const nonExecutableSkills = ["sus-finder", "error-finder", "optimizer"];
  if (!skillKey || nonExecutableSkills.includes(skillKey)) {
    return context.redirect(`/ai/actions/${action.id}/guide`);
  }

  const skillName = skill?.name || "Unknown";
  const skillIcon = skill?.icon || "fa-solid fa-gear";
  const skillIconImg = skill?.icon && !skill.icon.startsWith("fa-");
  const finding = action.findingId ? await models.SkillFinding.findByPk(action.findingId, { raw: true }) : null;
  let params = {};
  try { params = JSON.parse(action.parameters || "{}"); } catch {}

  // Load existing execution request (any status), or create new if action is still pending
  let exReq = await models.ExecutionRequest.findOne({
    where: { actionId: action.id },
    order: [["createdAt", "DESC"]],
  });

  if (!exReq) {
    if (action.status !== "pending") return context.redirect("/ai/actions");
    const commands = buildCommands(action.actionType, params, action.target);
    const displayId = await generateDisplayId(sequelize);
    const llmRow = await models.Setting.findByPk("llm_config");
    let llmConfig = null;
    try { if (llmRow) llmConfig = JSON.parse(llmRow.value); } catch {}
    const contextStr = finding ? `${finding.title || ""} — ${finding.description || ""}` : "";
    const { explanation, riskLevel, affected } = await generateExplanation(llmConfig, commands, action.actionType, contextStr);
    exReq = await models.ExecutionRequest.create({
      displayId, actionId: action.id, actionType: action.actionType,
      commands: JSON.stringify(commands), explanation, riskLevel, affected,
      revisionHistory: "[]", status: "pending",
    });
  }

  // Parse stored data for template
  const commands = JSON.parse(exReq.commands || "[]");
  const revisionHistory = JSON.parse(exReq.revisionHistory || "[]");
  const riskBadgeClass = exReq.riskLevel === "high" ? "text-bg-danger" : exReq.riskLevel === "medium" ? "text-bg-warning" : "text-bg-info";
  const created = exReq.createdAt ? new Date(exReq.createdAt).toLocaleString() : new Date().toLocaleString();
  const isProcessed = exReq.status !== "pending";

  return renderPage(context, "ai-execute-confirm", {
    actionId: action.id,
    skillName, skillIcon, skillIconImg,
    findingTitle: finding?.title || "",
    findingDesc: finding?.description || "",
    findingSeverity: finding?.severity || "",
    severityBadge: finding?.severity === "critical" ? "text-bg-danger" : finding?.severity === "warning" ? "text-bg-warning" : "text-bg-info",
    findingPattern: finding?.pattern || "",
    actionCreatedAt: action.createdAt ? new Date(action.createdAt).toLocaleString() : "—",
    displayId: exReq.displayId,
    actionType: exReq.actionType,
    commands,
    hasCommands: commands.length > 0,
    explanation: exReq.explanation,
    riskLevel: exReq.riskLevel,
    riskBadgeClass,
    affected: exReq.affected,
    created,
    revisionHistory: revisionHistory.map((m) => ({ ...m, isUser: m.role === "user" })),
    hasRevisionHistory: revisionHistory.length > 0,
    isProcessed,
    exReqStatus: exReq.status,
    executed: isProcessed && exReq.status === "executed" && context.req.query("executed") === "1",
    dismissed: isProcessed && exReq.status === "dismissed",
    done: isProcessed && exReq.status === "done",
    failed: isProcessed && exReq.status === "failed",
    executedMessage: context.req.query("executed") === "1",
    dismissedMessage: context.req.query("dismissed") === "1",
    doneMessage: context.req.query("done") === "1",
  }, { title: "Execution Confirmation — Symbio" });
});

/**
 * Processes the execution request: apply (execute), dismiss, mark done, or revise.
 */
protectedRoutes.post("/ai/actions/:id/execute", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action) return context.redirect("/ai/actions");

  const exReq = await models.ExecutionRequest.findOne({
    where: { actionId: action.id, status: "pending" },
    order: [["createdAt", "DESC"]],
  });
  if (!exReq) return context.redirect("/ai/actions");

  const formAction = context.req.body?.action || "";

  // — revise: AI adjusts commands based on user question —
  if (formAction === "revise") {
    const userMessage = (context.req.body?.revise_message || "").trim();
    if (!userMessage) return context.redirect(`/ai/actions/${action.id}/execute`);

    const commands = JSON.parse(exReq.commands || "[]");
    const revisionHistory = JSON.parse(exReq.revisionHistory || "[]");

    // Load LLM config
    const llmRow = await models.Setting.findByPk("llm_config");
    let llmConfig = null;
    try { if (llmRow) llmConfig = JSON.parse(llmRow.value); } catch {}

    const result = await reviseCommands(llmConfig, commands, exReq.actionType, userMessage, revisionHistory);

    // Append to revision history
    revisionHistory.push({ role: "user", message: userMessage, timestamp: new Date().toISOString() });
    revisionHistory.push({
      role: "assistant",
      message: result.explanation || "Commands revised.",
      commands: result.commands,
      timestamp: new Date().toISOString(),
    });

    exReq.commands = JSON.stringify(result.commands);
    exReq.explanation = result.explanation;
    exReq.riskLevel = result.riskLevel;
    exReq.affected = result.affected;
    exReq.revisionHistory = JSON.stringify(revisionHistory);
    exReq.updatedAt = new Date();
    await exReq.save();

    return context.redirect(`/ai/actions/${action.id}/execute`);
  }

  // — apply: execute the commands with proof —
  if (formAction === "apply") {
    const commands = JSON.parse(exReq.commands || "[]");
    if (!commands.length) return context.redirect(`/ai/actions/${action.id}/execute`);

    try {
      const proof = await executeWithProof({ action: action.actionType, params: JSON.parse(action.parameters || "{}") });
      action.status = "executed";
      action.result = JSON.stringify(proof);
      action.approvedBy = context.get("auth")?.user?.username || "unknown";
      action.approvedAt = new Date();
      action.executedAt = new Date();
      await action.save();

      exReq.status = "executed";
      exReq.updatedAt = new Date();
      await exReq.save();

      // Close the associated finding
      if (action.findingId) {
        try { await models.SkillFinding.update({ status: "resolved" }, { where: { id: action.findingId } }); } catch {}
      }
    } catch (error) {
      action.status = "failed";
      action.result = JSON.stringify({ error: error.message });
      await action.save();
      exReq.status = "failed";
      exReq.updatedAt = new Date();
      await exReq.save();
    }
    return context.redirect(`/ai/actions/${action.id}/execute?executed=1`);
  }

  // — dismiss: acknowledge and ignore —
  if (formAction === "dismiss") {
    action.status = "acknowledged";
    action.approvedBy = context.get("auth")?.user?.username || "unknown";
    action.approvedAt = new Date();
    await action.save();

    exReq.status = "dismissed";
    exReq.updatedAt = new Date();
    await exReq.save();

    return context.redirect(`/ai/actions/${action.id}/execute?dismissed=1`);
  }

  // — done: user ran the command manually —
  if (formAction === "done") {
    action.status = "done";
    action.approvedBy = context.get("auth")?.user?.username || "unknown";
    action.approvedAt = new Date();
    await action.save();

    exReq.status = "done";
    exReq.updatedAt = new Date();
    await exReq.save();

    // Close the associated finding
    if (action.findingId) {
      try { await models.SkillFinding.update({ status: "resolved" }, { where: { id: action.findingId } }); } catch {}
    }

    return context.redirect(`/ai/actions/${action.id}/execute?done=1`);
  }

  return context.redirect("/ai/actions");
});

/** Clarify a finding — calls AI to explain in plain language with actionable steps. */
protectedRoutes.get("/ai/actions/:id/clarify", async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"), { raw: true });
  if (!action) return context.notFound();
  const finding = await models.SkillFinding.findByPk(action.findingId, { raw: true });
  const run = await models.SkillRun.findByPk(action.skillRunId, { raw: true });
  const skill = run ? await models.Skill.findByPk(run.skillId, { raw: true }) : null;
  const llmRow = await models.Setting.findByPk("llm_config");
  let llmConfig = null;
  try { if (llmRow) llmConfig = JSON.parse(llmRow.value); } catch {}
  let response = null, error = null, responseHtml = null;
  const askStartTime = Date.now();
  if (llmConfig) {
    const { askAI } = await import("../services/llm.service.js");
    const contextParts = [
      `Finding title: ${finding?.title || "—"}`,
      `Finding description: ${finding?.description || "—"}`,
      `Severity: ${finding?.severity || "info"}`,
      `Source: ${finding?.source || "—"}`,
      `Skill: ${skill?.name || "Unknown"} (${skill?.key || ""})`,
      `Action type: ${action.action_type || ""}`,
      `Target: ${action.target || ""}`,
    ];
    if (run?.dataCollected) {
      try {
        const dc = JSON.parse(run.dataCollected);
        const dcPreview = JSON.stringify(dc).slice(0, 3000);
        contextParts.push("\n--- SERVER CONTEXT ---\n" + dcPreview);
      } catch {}
    }
    const contextData = contextParts.join("\n");
    const systemHint = "Given the security/maintenance finding above, explain in plain language:\n\n1. What this actually means — is it a real threat or likely a false positive?\n2. Exact shell commands to investigate (provide the actual commands)\n3. What the admin should do\n\nBe direct and specific. Stick to what the data shows — do not make up information. If crucial details are missing, say so.\n\nRespond in plain text paragraphs. Use brief code blocks for shell commands when appropriate.";
    const result = await askAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey || llmConfig.secretKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      logContent: contextData, question: systemHint,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    const responseTimeMs = Date.now() - askStartTime;
    if (result.error) error = result.error;
    else {
      response = result.content;
      responseHtml = response ? renderMarkdown(response) : null;
    }
    // Track token usage for this clarify call
    if (result.usage) await accumulateUsage(result.usage, { model: llmConfig.model, source: "clarify" });
    // Log to AI history for audit trail
    try {
      const requestText = `[CLARIFY]\n\nFinding:\n${contextData}\n\nQuestion:\n${systemHint}`;
      await models.AIHistory.create({
        provider: llmConfig.provider, model: llmConfig.model || "",
        question: `Clarify: ${(finding?.title || action.action_type || "").slice(0, 100)}`,
        logContent: contextData.slice(0, 3000), context: null,
        requestText, responseText: response || "",
        reasoningContent: null, responseHtml,
        tokenInput: result.usage?.promptTokens || 0,
        tokenOutput: result.usage?.completionTokens || 0,
        tokenTotal: result.usage?.totalTokens || 0,
        responseTimeMs, logName: skill?.name || "Clarify", sourceUrl: `/ai/actions/${action.id}/clarify`,
        logType: "clarify",
      });
    } catch {}
  } else {
    error = "LLM is not configured. Go to Settings > LLM Integration to set up an API key.";
  }
  const severityBadge = (sev) => sev === "critical" ? "text-bg-danger" : sev === "warning" ? "text-bg-warning" : "text-bg-info";
  return renderPage(context, "ai-clarify", {
    skillName: skill?.name || "Unknown",
    skillIcon: skill?.icon || "fa-solid fa-gear", skillIconImg: !(skill?.icon || "").startsWith("fa-"),
    severity: finding?.severity || "info",
    severityBadge: severityBadge(finding?.severity),
    source: finding?.source || "—",
    pattern: action.parameters ? (() => { try { return JSON.parse(action.parameters).pattern || ""; } catch { return ""; } })() : "",
    findingTitle: finding?.title || "",
    findingDescription: finding?.description || "",
    responseHtml,
    response,
    error,
    loading: false,
  }, { title: "Clarify Finding — Symbio" });
});

/** Mark Handled page — optional user explanation before marking as done. */
protectedRoutes.get("/ai/actions/:id/handle", async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"), { raw: true });
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  const finding = await models.SkillFinding.findByPk(action.findingId, { raw: true });
  const run = await models.SkillRun.findByPk(action.skillRunId, { raw: true });
  const skill = run ? await models.Skill.findByPk(run.skillId, { raw: true }) : null;
  const severityBadge = (sev) => sev === "critical" ? "text-bg-danger" : sev === "warning" ? "text-bg-warning" : "text-bg-info";
  return renderPage(context, "ai-mark-handled", {
    actionId: action.id,
    skillName: skill?.name || "Unknown",
    skillIcon: skill?.icon || "fa-solid fa-gear", skillIconImg: !(skill?.icon || "").startsWith("fa-"),
    severity: finding?.severity || "info",
    severityBadge: severityBadge(finding?.severity),
    source: finding?.source || "—",
    pattern: action.parameters ? (() => { try { return JSON.parse(action.parameters).pattern || ""; } catch { return ""; } })() : "",
    findingTitle: finding?.title || "",
    findingDescription: finding?.description || "",
  }, { title: "Mark Handled — Symbio" });
});

/** Dismisses ALL pending actions in one go: marks acknowledged, adds patterns to skill configs, closes findings. */
protectedRoutes.post("/ai/actions/dismiss-all", requireCsrf, async (context) => {
  const auth = context.get("auth");
  const now = new Date();
  const username = auth?.user?.username || "unknown";

  // Load raw pending actions with skill info for pattern collection
  const [rawActions] = await sequelize.query(`
    SELECT sa.id, sa.finding_id, sa.parameters, sr.skill_id
    FROM skill_actions sa
    JOIN skill_runs sr ON sa.skill_run_id = sr.id
    WHERE sa.status = 'pending'
  `);
  if (!rawActions.length) return context.redirect("/ai/actions");

  const ids = [];
  const findingIds = [];
  const skillPatterns = new Map();

  for (const a of rawActions) {
    ids.push(a.id);
    if (a.finding_id) findingIds.push(a.finding_id);
    let params = {};
    try { params = JSON.parse(a.parameters || "{}"); } catch {}
    const pattern = params.pattern || "";
    if (pattern && a.skill_id) {
      if (!skillPatterns.has(a.skill_id)) skillPatterns.set(a.skill_id, new Set());
      skillPatterns.get(a.skill_id).add(pattern);
    }
  }

  // Bulk-update all pending actions
  await models.SkillAction.update(
    { status: "acknowledged", approved_by: username, approved_at: now },
    { where: { id: ids } },
  );

  // Close all associated findings
  if (findingIds.length) {
    await models.SkillFinding.update(
      { status: "acknowledged" },
      { where: { id: findingIds } },
    );
  }

  // Add unique patterns to each skill's ignorePatterns
  for (const [skillId, patterns] of skillPatterns) {
    try {
      const skill = await models.Skill.findByPk(skillId);
      if (!skill) continue;
      let config = {};
      try { config = JSON.parse(skill.config || "{}"); } catch {}
      if (!Array.isArray(config.ignorePatterns)) config.ignorePatterns = [];
      for (const p of patterns) {
        if (!config.ignorePatterns.includes(p)) config.ignorePatterns.push(p);
      }
      skill.config = JSON.stringify(config);
      await skill.save();
    } catch {}
  }

  return context.redirect("/ai/actions?acknowledged=1");
});

/** Processes Mark Handled: saves user note to skill memory, adds pattern to ignore list, marks action done. */
protectedRoutes.post("/ai/actions/:id/handle", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  const form = context.get("form");
  const note = String(form.note || "").trim();
  const suppress = form.suppress === "1";
  let params = {};
  try { params = JSON.parse(action.parameters || "{}"); } catch {}
  const pattern = params.pattern || "";

  // Mark as done
  action.status = "done";
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();

  // Close the associated finding
  if (action.findingId) {
    try {
      await models.SkillFinding.update({ status: "resolved" }, { where: { id: action.findingId } });
    } catch {}
  }

  // If suppress is checked, add pattern to skill config ignorePatterns
  if (suppress && pattern && action.skillRunId) {
    try {
      const run = await models.SkillRun.findByPk(action.skillRunId);
      if (run) {
        const skill = await models.Skill.findByPk(run.skillId);
        if (skill) {
          let config = {};
          try { config = JSON.parse(skill.config || "{}"); } catch {}
          if (!Array.isArray(config.ignorePatterns)) config.ignorePatterns = [];
          if (!config.ignorePatterns.includes(pattern)) {
            config.ignorePatterns.push(pattern);
            skill.config = JSON.stringify(config);
          }
          // If user left a note, append to skill memory with timestamp
          if (note) {
            const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
            const memoryEntry = `[${timestamp}] User note: ${note.slice(0, 1000)}`;
            const memory = skill.memory || "";
            const updated = memory ? `${memory}\n${memoryEntry}` : memoryEntry;
            skill.memory = updated.slice(-2000);
          }
          await skill.save();
        }
      }
    } catch {}
  }
  return context.redirect("/ai/actions?handled=1");
});

/** Fix Guide page — AI-generated step-by-step tutorial for manually fixing a finding. */
protectedRoutes.get("/ai/actions/:id/guide", async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"), { raw: true });
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  const finding = await models.SkillFinding.findByPk(action.findingId, { raw: true });
  const run = await models.SkillRun.findByPk(action.skillRunId, { raw: true });
  const skill = run ? await models.Skill.findByPk(run.skillId, { raw: true }) : null;

  // Get the collected data from the run for server context
  let dataCollected = "No server context available.";
  if (run?.dataCollected) {
    try { dataCollected = JSON.stringify(JSON.parse(run.dataCollected), null, 2).slice(0, 5000); } catch {}
  }

  const llmRow = await models.Setting.findByPk("llm_config");
  let llmConfig = null;
  try { if (llmRow) llmConfig = JSON.parse(llmRow.value); } catch {}
  let guideHtml = null, error = null;
  if (llmConfig) {
    const { askAI } = await import("../services/llm.service.js");
    let params = {};
    try { params = JSON.parse(action.parameters || "{}"); } catch {}
    const contextData = [
      `=== FINDING ===`,
      `Title: ${finding?.title || "—"}`,
      `Description: ${finding?.description || "—"}`,
      `Severity: ${finding?.severity || "info"}`,
      `Source: ${finding?.source || "—"}`,
      `Suggested commands: ${JSON.stringify(params.commands || [])}`,
      `Config file: ${params.configFile || "—"}`,
      `Changes: ${params.changes || "—"}`,
      ``,
      `=== SERVER CONTEXT (collected data) ===`,
      dataCollected,
    ].join("\n");
    const systemHint = "You are a senior Linux system administrator writing a guide for a colleague. Given the finding below and the server's current state, write a numbered step-by-step guide to fix the issue.\n\nRules:\n- Write actual shell commands the admin can copy-paste\n- Explain WHY each step is needed\n- Note any risks or side effects\n- Tailor the advice to the specific server (OS, kernel, RAM, disk from the context)\n- If the finding is likely a false positive or no action is needed, say so clearly\n- Format with clear headings, code blocks for commands, and warnings where appropriate\n- Do NOT suggest anything destructive (rm -rf, format, etc.)\n- Do NOT make up commands — only suggest what the finding or server context supports\n\nRespond in plain text paragraphs with code blocks for commands.";
    const result = await askAI({
      provider: llmConfig.provider, apiKey: llmConfig.apiKey || llmConfig.secretKey,
      endpoint: llmConfig.endpoint, model: llmConfig.model,
      logContent: contextData, question: systemHint,
      language: llmConfig.language, personality: llmConfig.personality,
      customInstruction: llmConfig.customInstruction,
    });
    if (result.error) error = result.error;
    else guideHtml = renderMarkdown(result.content);
    if (result.usage) await accumulateUsage(result.usage, { model: llmConfig.model, source: "fix-guide" });
    // Log to AI history
    try {
      const requestText = `[FIX GUIDE]\n\n${contextData}\n\nPrompt:\n${systemHint}`;
      await models.AIHistory.create({
        provider: llmConfig.provider, model: llmConfig.model || "",
        question: `Fix Guide: ${(finding?.title || action.action_type || "").slice(0, 100)}`,
        logContent: contextData.slice(0, 3000), context: null,
        requestText, responseText: result.content || "",
        reasoningContent: null, responseHtml: guideHtml,
        tokenInput: result.usage?.promptTokens || 0,
        tokenOutput: result.usage?.completionTokens || 0,
        tokenTotal: result.usage?.totalTokens || 0,
        responseTimeMs: 0, logName: skill?.name || "Fix Guide",
        sourceUrl: `/ai/actions/${action.id}/guide`, logType: "fix-guide",
      });
    } catch {}
  } else {
    error = "LLM is not configured. Go to Settings > LLM Integration to set up an API key.";
  }
  const severityBadge = (sev) => sev === "critical" ? "text-bg-danger" : sev === "warning" ? "text-bg-warning" : "text-bg-info";
  return renderPage(context, "ai-fix-guide", {
    actionId: action.id,
    skillName: skill?.name || "Unknown",
    skillIcon: skill?.icon || "fa-solid fa-gear", skillIconImg: !(skill?.icon || "").startsWith("fa-"),
    severity: finding?.severity || "info",
    severityBadge: severityBadge(finding?.severity),
    source: finding?.source || "—",
    pattern: action.parameters ? (() => { try { return JSON.parse(action.parameters).pattern || ""; } catch { return ""; } })() : "",
    findingTitle: finding?.title || "",
    findingDescription: finding?.description || "",
    guideHtml, error,
    serverContext: dataCollected,
  }, { title: "Fix Guide — Symbio" });
});

/** Processes Fix Guide result: mark as done or dismiss. */
protectedRoutes.post("/ai/actions/:id/guide", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  const form = context.get("form");
  const actionType = form.action === "done" ? "done" : "acknowledged";

  action.status = actionType;
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();

  // Close the associated finding
  if (action.findingId) {
    try {
      await models.SkillFinding.update({ status: actionType === "done" ? "resolved" : "acknowledged" }, { where: { id: action.findingId } });
    } catch {}
  }

  // Add pattern to ignore list for both done and dismiss
  let params = {};
  try { params = JSON.parse(action.parameters || "{}"); } catch {}
  const pattern = params.pattern || "";
  if (pattern && action.skillRunId) {
    try {
      const run = await models.SkillRun.findByPk(action.skillRunId);
      if (run) {
        const skill = await models.Skill.findByPk(run.skillId);
        if (skill) {
          let config = {};
          try { config = JSON.parse(skill.config || "{}"); } catch {}
          if (!Array.isArray(config.ignorePatterns)) config.ignorePatterns = [];
          if (!config.ignorePatterns.includes(pattern)) {
            config.ignorePatterns.push(pattern);
            skill.config = JSON.stringify(config);
            await skill.save();
          }
        }
      }
    } catch {}
  }
  const suffix = actionType === "done" ? "handled=1" : "acknowledged=1";
  return context.redirect(`/ai/actions?${suffix}`);
});

/** Approves a skill action: captures before, executes, captures after, updates status. */
protectedRoutes.post("/ai/actions/:id/approve", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  try {
    const params = JSON.parse(action.parameters || "{}");
    const proof = await executeWithProof({ action: action.actionType, params });
    action.status = "executed";
    action.approved_by = context.get("auth")?.user?.username || "unknown";
    action.approved_at = new Date();
    action.executed_at = new Date();
    action.result = JSON.stringify(proof);
    await action.save();
  } catch (error) {
    action.status = "failed";
    action.result = JSON.stringify({ error: error.message });
    await action.save();
  }
  return context.redirect("/ai/actions?approved=1");
});

/** Rejects a skill action (ignore). */
protectedRoutes.post("/ai/actions/:id/reject", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  action.status = "rejected";
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();
  return context.redirect("/ai/actions?rejected=1");
});

/** Marks a skill action as done (user handled it manually). */
protectedRoutes.post("/ai/actions/:id/done", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  action.status = "done";
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();
  // Close the associated finding
  if (action.findingId) {
    try {
      await models.SkillFinding.update({ status: "resolved" }, { where: { id: action.findingId } });
    } catch {}
  }
  return context.redirect("/ai/actions?done=1");
});

/** Dismisses a skill action: marks acknowledged + adds pattern to skill config ignorePatterns so it never reappears. */
protectedRoutes.post("/ai/actions/:id/acknowledge", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"));
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  action.status = "acknowledged";
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();

  // Close the associated finding
  if (action.findingId) {
    try {
      await models.SkillFinding.update({ status: "acknowledged" }, { where: { id: action.findingId } });
    } catch {}
  }

  // Also add the pattern to the skill's ignorePatterns to prevent re-alerting
  let params = {};
  try { params = JSON.parse(action.parameters || "{}"); } catch {}
  const pattern = params.pattern || "";
  if (pattern && action.skillRunId) {
    const run = await models.SkillRun.findByPk(action.skillRunId);
    if (run) {
      const skill = await models.Skill.findByPk(run.skillId);
      if (skill) {
        let config = {};
        try { config = JSON.parse(skill.config || "{}"); } catch {}
        if (!Array.isArray(config.ignorePatterns)) config.ignorePatterns = [];
        if (!config.ignorePatterns.includes(pattern)) {
          config.ignorePatterns.push(pattern);
          skill.config = JSON.stringify(config);
          await skill.save();
        }
        // Reject all other pending actions with the same pattern
        const allPending = await models.SkillAction.findAll({ where: { status: "pending" } });
        for (const a of allPending) {
          if (a.id === action.id) continue;
          let p = {};
          try { p = JSON.parse(a.parameters || "{}"); } catch {}
          if (p.pattern && pattern && p.pattern.includes(pattern)) {
            a.status = "acknowledged";
            a.approved_by = action.approved_by;
            a.approved_at = new Date();
            await a.save();
          }
        }
      }
    }
  }
  return context.redirect("/ai/actions?acknowledged=1");
});

/** Ignores a pattern from a skill action: adds to skill config's ignorePatterns, rejects all matching pending actions. */
protectedRoutes.post("/ai/actions/:id/ignore-pattern", requireCsrf, async (context) => {
  const action = await models.SkillAction.findByPk(context.req.param("id"), { include: [models.SkillRun] });
  if (!action || action.status !== "pending") return context.redirect("/ai/actions");
  let params = {};
  try { params = JSON.parse(action.parameters || "{}"); } catch {}
  const pattern = params.pattern || "";
  if (pattern && action.skillRunId) {
    // Add pattern to parent skill's config.ignorePatterns
    const run = await models.SkillRun.findByPk(action.skillRunId);
    if (run) {
      const skill = await models.Skill.findByPk(run.skillId);
      if (skill) {
        let config = {};
        try { config = JSON.parse(skill.config || "{}"); } catch {}
        if (!Array.isArray(config.ignorePatterns)) config.ignorePatterns = [];
        if (!config.ignorePatterns.includes(pattern)) {
          config.ignorePatterns.push(pattern);
          skill.config = JSON.stringify(config);
          await skill.save();
        }
        // Reject all other pending actions with the same pattern
        const samePattern = await models.SkillAction.findAll({
          where: { status: "pending" },
        });
        for (const a of samePattern) {
          if (a.id === action.id) continue;
          let p = {};
          try { p = JSON.parse(a.parameters || "{}"); } catch {}
          if (p.pattern === pattern) {
            a.status = "rejected";
            await a.save();
          }
        }
      }
    }
  }
  action.status = "rejected";
  action.approved_by = context.get("auth")?.user?.username || "unknown";
  action.approved_at = new Date();
  await action.save();

  // Close the associated finding
  if (action.findingId) {
    try {
      await models.SkillFinding.update({ status: "acknowledged" }, { where: { id: action.findingId } });
    } catch {}
  }
  return context.redirect("/ai/actions?ignored=1");
});

/** View a specific AI history entry. */
/** Skill Run detail page — full info about a single run. */
protectedRoutes.get("/ai/skill-run/:id", async (context) => {
  const run = await models.SkillRun.findByPk(context.req.param("id"), { raw: true });
  if (!run) return context.notFound();
  const skill = await models.Skill.findByPk(run.skillId, { raw: true });
  const findings = await models.SkillFinding.findAll({ where: { skillRunId: run.id }, raw: true });
  const actions = await models.SkillAction.findAll({ where: { skillRunId: run.id }, raw: true });
  const tokenUsage = await models.TokenUsage.findOne({ where: { skillRunId: run.id }, raw: true });
  const dur = run.startedAt && run.finishedAt
    ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000) + "s"
    : (run.startedAt ? Math.round((Date.now() - new Date(run.startedAt)) / 1000) + "s (running)" : "—");
  const severityBadge = (sev) => sev === "critical" ? "text-bg-danger" : sev === "warning" ? "text-bg-warning" : "text-bg-info";
  const actionStatusBadge = (s) => s === "executed" ? "text-bg-success" : s === "pending" ? "text-bg-warning" : s === "done" ? "text-bg-info" : s === "acknowledged" ? "text-bg-secondary" : s === "rejected" ? "text-bg-danger" : "text-bg-secondary";
  return renderPage(context, "skill-run-detail", {
    run: {
      id: run.id,
      skillName: skill?.name || "Unknown",
      trigger: run.trigger || "scheduled",
      status: run.status,
      statusBadge: run.status === "completed" ? "text-bg-success" : run.status === "running" ? "text-bg-info" : run.status === "failed" ? "text-bg-danger" : "text-bg-secondary",
      statusLabel: run.status.charAt(0).toUpperCase() + run.status.slice(1),
      startedAt: run.startedAt ? new Date(run.startedAt).toLocaleString() : "—",
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—",
      duration: dur,
      summary: run.summary || "—",
      errorMessage: run.errorMessage || "",
      failed: run.status === "failed",
    },
    llmUsage: tokenUsage ? {
      model: tokenUsage.model || "—", modelLogo: modelLogo(tokenUsage.model),
      totalTokens: tokenUsage.total_tokens || 0,
      promptTokens: tokenUsage.prompt_tokens || 0,
      completionTokens: tokenUsage.completion_tokens || 0,
    } : null,
    findings: findings.map((f) => ({
      severity: f.severity || "info",
      severityBadge: severityBadge(f.severity),
      source: f.source || "—",
      title: f.title || "",
      description: f.description || "",
      suggestedFix: f.suggestedFix || "—",
      seenCount: f.seenCount || 1,
      seenCountMore: (f.seenCount || 1) > 1,
      findingStatus: f.status || "open",
      findingStatusBadge: f.status === "open" ? "text-bg-info" : f.status === "acknowledged" ? "text-bg-secondary" : f.status === "resolved" ? "text-bg-success" : "text-bg-info",
    })),
    actions: actions.map((a) => ({
      id: a.id,
      actionType: a.actionType || "",
      target: a.target || "",
      status: a.status,
      statusBadge: actionStatusBadge(a.status),
      statusLabel: a.status.charAt(0).toUpperCase() + a.status.slice(1),
      result: a.result || "",
      hasResult: !!a.result,
    })),
  }, { title: `${skill?.name || "Skill Run"} #${run.id} — Symbio` });
});

protectedRoutes.get("/ai/history/:id", async (context) => {
  const entry = await models.AIHistory.findByPk(context.req.param("id"));
  if (!entry) return context.notFound();
  return renderPage(context, "ai-response", {
    server: null, question: entry.question, logName: entry.logName || "Log", sourceUrl: entry.sourceUrl || "/ai/history",
    content: entry.responseText || "", contentHtml: entry.responseHtml || null,
    reasoningContent: entry.reasoningContent || null,
    usage: entry.tokenTotal ? { promptTokens: entry.tokenInput, completionTokens: entry.tokenOutput, totalTokens: entry.tokenTotal } : null,
    model: entry.model, responseTimeMs: entry.responseTimeMs,
    requestText: entry.requestText || "", historyId: entry.id,
    error: "", showAskAgain: false,
  }, { title: `AI Analysis — ${entry.logName || "AI History"} — Symbio` });
});

/** Clears all AI history entries. */
protectedRoutes.post("/ai/history/clear", requireCsrf, async (context) => {
  await models.AIHistory.destroy({ where: {} });
  return context.redirect("/ai/history?cleared=1");
});

/** Shows the profile form for the current user. */
protectedRoutes.get("/profile", async (context) => {
  const auth = context.get("auth");
  const currentLang = auth.user.language || "en";
  return renderPage(context, "profile", {
    user: {
      username: auth.user.username, email: auth.user.email,
      displayName: auth.user.displayName, language: currentLang,
    },
    languageChoices: LANGUAGE_CHOICES.map((choice) => ({
      ...choice, selected: choice.code === currentLang,
    })),
    saved: context.req.query("saved") === "1",
    error: context.req.query("error") || "",
  }, { title: "Profile — Symbio" });
});

/** Updates display name, password, and/or language for the current user. */
protectedRoutes.post("/profile", requireCsrf, async (context) => {
  const auth = context.get("auth");
  const form = context.get("form");
  try {
    const displayName = String(form.displayName || "").trim().slice(0, 128);
    if (!displayName) throw new Error("Display name is required.");
    auth.user.displayName = displayName;
    const newPassword = String(form.password || "").trim();
    if (newPassword) auth.user.passwordHash = await hashPassword(newPassword);
    const language = String(form.language || "en").trim();
    const validCodes = LANGUAGE_CHOICES.map((c) => c.code);
    if (validCodes.includes(language)) auth.user.language = language;
    await auth.user.save();
    if (newPassword) {
      const { destroyAllUserSessions, createSession } = await import("../lib/auth.js");
      await destroyAllUserSessions(auth.user.id);
      await createSession(context, auth.user.id);
    }
    return context.redirect("/profile?saved=1");
  } catch (error) {
    return context.redirect(`/profile?error=${encodeURIComponent(error.message)}`);
  }
});

/** Shows the maximum trustworthy runtime view available without Docker socket access. */
protectedRoutes.get("/installation-status", async (context) => {
  const [agent, migrationRows, serviceRows] = await Promise.all([
    models.Agent.findOne({ where: { agentKey: "main-agent" } }),
    sequelize.query("SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version", { type: QueryTypes.SELECT }),
    loadServices(),
  ]);
  const components = serviceRegistry.getAll().map((comp) => {
    const dbService = serviceRows.find((row) => row.type === comp.type);
    return {
      type: comp.type, icon: comp.icon, displayName: comp.displayName, description: comp.description,
      enabled: dbService?.enabled ? "Enabled" : "Disabled",
      registered: true,
    };
  });
  const port = process.env.SYMBIO_PORT || "8765";
  const internalPort = process.env.SYMBIO_INTERNAL_PORT || "18766";

  // Storage status — reads database file sizes and data volume usage
  const dbPath = process.env.SYMBIO_DATABASE_PATH || "/data/mothership.sqlite";
  let dbSize = null, dbWalSize = null, dbShmSize = null;
  let volumeTotal = null, volumeUsed = null, volumeAvail = null, volumePercent = null;
  try {
    const dbStat = fs.statSync(dbPath);
    dbSize = dbStat.size;
  } catch {}
  try {
    const walStat = fs.statSync(dbPath + "-wal");
    dbWalSize = walStat.size;
  } catch {}
  try {
    const shmStat = fs.statSync(dbPath + "-shm");
    dbShmSize = shmStat.size;
  } catch {}
  try {
    const sf = fs.statfsSync("/data");
    volumeTotal = sf.blocks * sf.bsize;
    volumeAvail = sf.bavail * sf.bsize;
    volumeUsed = volumeTotal - sf.bfree * sf.bsize;
    volumePercent = volumeTotal > 0 ? Math.round((volumeUsed / volumeTotal) * 100) : 0;
  } catch {}

  const fmt = (bytes) => {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  };

  return renderPage(context, "installation-status", {
    version: process.env.npm_package_version || "beta",
    publicBinding: `${process.env.SYMBIO_BIND_IP || "0.0.0.0"}:${port}`,
    internalBinding: `127.0.0.1:${internalPort}`,
    mothershipHealth: "Available on this page",
    agentHealth: serverState(agent?.lastSeenAt),
    agentHealthClass: statusClass(serverState(agent?.lastSeenAt)),
    lastReport: agent?.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "Never",
    migrations: migrationRows,
    components,
    dbSize: fmt(dbSize),
    dbSizeRaw: dbSize,
    dbWalSize: fmt(dbWalSize),
    dbWalExists: dbWalSize != null,
    dbShmSize: fmt(dbShmSize),
    dbShmExists: dbShmSize != null,
    volumeTotal: fmt(volumeTotal),
    volumeUsed: fmt(volumeUsed),
    volumeAvail: fmt(volumeAvail),
    volumePercent,
    volumePercentClass: volumePercent == null ? "bg-secondary" : volumePercent >= 90 ? "bg-danger" : volumePercent >= 70 ? "bg-warning" : "bg-success",
  }, { title: "Installation Status — Symbio" });
});

const api = new Hono();
api.use("*", requireApiAuth);
api.get("/summary", async (context) => {
  const [agent, status, applicationRows, serviceRows] = await Promise.all([
    models.Agent.findOne({ where: { agentKey: "main-agent" } }),
    models.ServerStatus.findOne({ order: [["observedAt", "DESC"]] }),
    loadApplications(), loadServices(),
  ]);
  const applications = decorateStatuses(applicationRows);
  const services = decorateStatuses(serviceRows);
  return context.json({
    ok: true, serverState: serverState(agent?.lastSeenAt), lastSeenAt: agent?.lastSeenAt,
    cpuPercent: formatPercent(status?.cpuPercent), memoryPercent: formatPercent(status?.memoryPercent), diskPercent: formatPercent(status?.diskPercent),
    applicationCounts: applications.reduce((result, item) => ({ ...result, [item.status || "unknown"]: (result[item.status || "unknown"] || 0) + 1 }), {}),
    serviceCounts: services.reduce((result, item) => ({ ...result, [item.status || "unknown"]: (result[item.status || "unknown"] || 0) + 1 }), {}),
  });
});

protectedRoutes.route("/api/v1", api);
router.route("/", protectedRoutes);

export { router as webRoutes };
