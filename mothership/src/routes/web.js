/**
 * Public web routes implement the complete server-rendered Phase 1 workflow;
 * JavaScript only enhances current-status refresh and is never required for CRUD.
 */

import { Hono } from "hono";
import { Op, QueryTypes } from "sequelize";
import { createSession, destroySession, requireApiAuth, requireAuth, requireCsrf, resolveSession } from "../lib/auth.js";
import { bucketSeries, chartRange, renderLineChart } from "../lib/charts.js";
import { formatBytes, formatPercent, formatUptime, rollingAverage } from "../lib/format.js";
import { renderPage } from "../lib/render.js";
import { clearLoginFailures, loginAllowed, recordLoginFailure, requestAddress } from "../lib/security.js";
import { verifyPassword } from "../lib/password.js";
import { models, sequelize } from "../db/index.js";
import { readApplicationLog, searchApplicationLog } from "../services/agent-log.service.js";
import { listDirectory, readFile, getDirectoryTree, viewFile } from "../services/file-manager.service.js";
import { fetchServerInfo, fetchProcessList, fetchListeningPorts, fetchMemoryDetail, fetchDiskIO, fetchLoggedInUsers, fetchInstalledPackages } from "../services/system.service.js";
import { serviceRegistry } from "../components/services/index.js";

const router = new Hono();
const LOG_TAIL_LIMITS = [50, 100, 200, 500, 1000];

/** Parses persisted JSON defensively so an old or malformed row cannot break SSR. */
const parseJson = (value, fallback) => { try { const parsed = JSON.parse(value || ""); return parsed ?? fallback; } catch { return fallback; } };
/** Narrows JSON values expected as persisted arrays for safe template iteration. */
const parseArray = (value) => { const parsed = parseJson(value, []); return Array.isArray(parsed) ? parsed : []; };

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
  const address = requestAddress(context);
  if (!loginAllowed(address)) return context.redirect("/login?error=Too+many+attempts.+Try+again+later.");
  const form = await context.req.parseBody();
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
  const sixHours = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const [server, agent, latestStatus, history, services, applications] = await Promise.all([
    models.Server.findOne({ where: { slug: "main-server" } }),
    models.Agent.findOne({ where: { agentKey: "main-agent" } }),
    models.ServerStatus.findOne({ order: [["observedAt", "DESC"]] }),
    models.ServerStatus.findAll({ where: { observedAt: { [Op.gte]: sixHours } }, raw: true }),
    loadServices(), loadApplications(),
  ]);
  const state = serverState(agent?.lastSeenAt);
  const decoratedServices = decorateStatuses(services);
  const decoratedApplications = decorateStatuses(applications);
  return renderPage(context, "dashboard", {
    server: server?.toJSON(), state, stateClass: statusClass(state),
    // The dashboard symbol makes current reachability readable without relying on color.
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
  return renderPage(context, "server-resource-charts", {
    server, range,
    cpuChart: renderLineChart([{ name: "CPU average", points: bucketSeries(history, "cpuPercent", range) }, ...Array.from(new Set(history.flatMap((row) => parseArray(row.cpuCoresJson).map((core) => core.id)))).map((id) => ({ name: id, points: bucketSeries(history.map((row) => ({ observedAt: row.observedAt, value: parseArray(row.cpuCoresJson).find((core) => core.id === id)?.percent })), "value", range) }))], "CPU usage", "%"),
    memoryChart: renderLineChart([{ name: "Memory", points: bucketSeries(history, "memoryPercent", range) }], "Memory usage", "%"),
    diskChart: renderLineChart([{ name: "Root storage", points: bucketSeries(history, "diskPercent", range) }], "Disk usage", "%"),
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
    totalBytes: result?.bytes || 0,
  }, { title: `${fileName} — File Viewer — Symbio` });
});

protectedRoutes.get("/servers/:serverId/services", async (context) => {
  const server = await models.Server.findByPk(context.req.param("serverId"));
  if (!server) return context.notFound();
  return renderPage(context, "services-list", {
    serverId: server.id,
    services: decorateStatuses(await loadServices({ serverId: server.id })),
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
  return renderPage(context, "service-form", { service: { ...service.toJSON(), ...configuration }, error: context.req.query("error") }, { title: `Edit ${service.displayName} — Symbio` });
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

/** Browses data from a MySQL table. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/mysql/databases/:db/tables/:table/browse", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "mysql") return context.notFound();
  const db = context.req.param("db");
  const table = context.req.param("table");
  const { fetchMySQLBrowse } = await import("../services/mysql.service.js");
  let columns = [];
  let rows = [];
  let error = "";
  try {
    const data = await fetchMySQLBrowse(db, table);
    columns = data.columns || [];
    // Transform rows from objects to ordered arrays matching columns
    const rawRows = data.rows || [];
    rows = rawRows.map((row) => columns.map((col) => {
      const val = row[col];
      return val === null ? "NULL" : val instanceof Date ? val.toISOString() : String(val);
    }));
  } catch (caught) { error = caught.message; }
  return renderPage(context, "components/services/mysql-browse", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, tableName: table, columns, rows, error,
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

/** Browses data from a PostgreSQL table. */
protectedRoutes.get("/servers/:serverId/services/:serviceId/postgresql/databases/:db/schemas/:schema/tables/:table/browse", async (context) => {
  const service = await models.ServerService.findByPk(context.req.param("serviceId"));
  if (!service || service.type !== "postgresql") return context.notFound();
  const db = context.req.param("db");
  const schema = context.req.param("schema");
  const table = context.req.param("table");
  const { fetchPGBrowse } = await import("../services/postgresql.service.js");
  let columns = [];
  let rows = [];
  let error = "";
  try {
    const data = await fetchPGBrowse(db, schema, table);
    columns = data.columns || [];
    const rawRows = data.rows || [];
    rows = rawRows.map((row) => columns.map((col) => {
      const val = row[col];
      return val === null ? "NULL" : val instanceof Date ? val.toISOString() : String(val);
    }));
  } catch (caught) { error = caught.message; }
  return renderPage(context, "components/services/postgresql-browse", {
    service: { ...service.toJSON(), serviceIcon: "fa-solid fa-database" },
    dbName: db, schemaName: schema, tableName: table, columns, rows, error,
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
  return renderPage(context, "applications-list", { applications, tags: await tagChoices() }, { title: "Applications — Symbio" });
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
  let result;
  let error = "";
  try { result = await readApplicationLog(log.id, limit); } catch (caught) { error = caught.message; }
  return renderPage(context, "application-log-viewer", {
    application: application.toJSON(), log: log.toJSON(), deleted: Boolean(application.deletedAt), tailChoices: logTailChoices(limit),
    logContent: result?.text || "", bytes: result?.bytes || 0, truncated: result?.truncated, lastReadAt: result ? new Date().toLocaleString() : "Not read", error,
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

protectedRoutes.get("/settings", (context) => renderPage(context, "settings", { language: "English" }, { title: "Settings — Symbio" }));

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
