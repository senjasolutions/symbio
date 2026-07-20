/** Private loopback Hono API exposes only local health and sanitized worker state. */

import { Hono } from "hono";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { OutboxReport } from "./db.js";
import { workerState, refreshConfiguration, getCurrentConfig } from "./worker.js";
import { config } from "./config.js";
import { readRegisteredTail, searchRegisteredLog, readSystemLog, searchSystemLog, TAIL_LIMITS, MAX_TAIL_SCAN_BYTES, boundedOutput, boundedLine, SEARCH_MATCH_LIMIT, SEARCH_CONTEXT_LINES } from "./log-reader.js";
import { listDirectory, readFileContent, getDirectoryTree } from "./file-manager.js";
import { viewFileContent, createFile, createDirectory, writeFile, deleteFileOrDir, renameFileOrDir, changeMode } from "./file-manager.js";
import { getServerInfo, getProcessList, getListeningPorts, getMemoryDetail, getDiskIO, getLoggedInUsers, getInstalledPackages, getTopProcesses } from "./system.js";
import { serviceRegistry } from "./components/services/index.js";
import { collectSkillData } from "./skills-collector.js";
import { ACTION_HANDLERS } from "./skills-executor.js";

/** Builds the intentionally small agent API reserved for local diagnostics. */
export const createAgentApp = () => {
  const app = new Hono();
  app.get("/healthz", (context) => context.json({ service: "symbio-agent", status: "ok" }));
  app.get("/api/v1/status", async (context) => context.json({
    service: "symbio-agent", status: "ok", outboxCount: await OutboxReport.count(),
    startedAt: workerState.startedAt, lastCollectionAt: workerState.lastCollectionAt,
    lastDeliveryAt: workerState.lastDeliveryAt, lastConfigAt: workerState.lastConfigAt,
    lastError: workerState.lastError,
    components: { services: serviceRegistry.getAll().map((c) => c.type) },
  }));
  return app;
};

/**
 * Single bridge Hono app exposes token-authenticated log operations and
 * read-only file manager features over the Docker bridge on one port.
 * All endpoints share one Bearer-token check so the mothership only needs
 * a single allowed port for all agent capabilities.
 */
export const createAgentBridgeApp = () => {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const auth = context.req.header("authorization");
    if (!auth || auth.trim() !== `Bearer ${config.agentToken}`.trim())
      return context.json({ ok: false, error: "Unauthorized" }, 401);
    await next();
  });

  // Helper: fetches current config, refreshing if a newly-added log source is requested.
  const sourceConfig = async (logId) => {
    let current = getCurrentConfig();
    if (!Array.isArray(current?.applicationLogs) || !current.applicationLogs.some((item) => Number(item.id) === Number(logId))) {
      await refreshConfiguration(); current = getCurrentConfig();
    }
    return current;
  };

  // ---- Log operations (existing) ----
  app.get("/api/v1/logs/:id/tail", async (context) => {
    try { return context.json({ ok: true, ...(await readRegisteredTail(await sourceConfig(context.req.param("id")), config.hostRootPath, context.req.param("id"), context.req.query("limit"))) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.post("/api/v1/logs/:id/search", async (context) => {
    try {
      const body = await context.req.json();
      return context.json({ ok: true, ...(await searchRegisteredLog(await sourceConfig(context.req.param("id")), config.hostRootPath, context.req.param("id"), body.query)) });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- System / Service / Symbio logs (predefined sources) ----
  const SYSTEM_LOG_SOURCES = {
    syslog: { displayName: "System Log", path: "/var/log/syslog" },
    auth: { displayName: "Authentication Log", path: "/var/log/auth.log" },
    kern: { displayName: "Kernel Log", path: "/var/log/kern.log" },
    dmesg: { displayName: "Kernel Ring Buffer", path: "/var/log/dmesg" },
    boot: { displayName: "Boot Log", path: "/var/log/boot.log" },
    dpkg: { displayName: "Package Manager Log", path: "/var/log/dpkg.log" },
    docker: { displayName: "Docker Daemon", path: "/var/log/docker.log" },
    "mysql-error": { displayName: "MySQL Error Log", path: "/var/log/mysql/error.log" },
    "postgresql-14": { displayName: "PostgreSQL 14", path: "/var/log/postgresql/postgresql-14-main.log" },
    "postgresql-15": { displayName: "PostgreSQL 15", path: "/var/log/postgresql/postgresql-15-main.log" },
    "postgresql-16": { displayName: "PostgreSQL 16", path: "/var/log/postgresql/postgresql-16-main.log" },
    redis: { displayName: "Redis Server", path: "/var/log/redis/redis-server.log" },
    "nginx-access": { displayName: "Nginx Access Log", path: "/var/log/nginx/access.log" },
    "nginx-error": { displayName: "Nginx Error Log", path: "/var/log/nginx/error.log" },
    "apache-access": { displayName: "Apache Access Log", path: "/var/log/apache2/access.log" },
    "apache-error": { displayName: "Apache Error Log", path: "/var/log/apache2/error.log" },
  };

  app.get("/api/v1/system-logs/read", async (context) => {
    try {
      const source = context.req.query("source");
      if (!source || !SYSTEM_LOG_SOURCES[source]) return context.json({ ok: false, error: "Unknown log source." }, 400);
      return context.json({ ok: true, ...(await readSystemLog(config.hostRootPath, SYSTEM_LOG_SOURCES[source].path, context.req.query("limit"))) });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.post("/api/v1/system-logs/search", async (context) => {
    try {
      const source = context.req.query("source");
      if (!source || !SYSTEM_LOG_SOURCES[source]) return context.json({ ok: false, error: "Unknown log source." }, 400);
      const { query } = await context.req.parseBody();
      return context.json({ ok: true, ...(await searchSystemLog(config.hostRootPath, SYSTEM_LOG_SOURCES[source].path, String(query || ""))) });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.get("/api/v1/symbio-logs/agent", async (context) => {
    try {
      const AGENT_LOG_PATH = "/data/logs/agent.log";
      const limit = Number(context.req.query("limit")) || 100;
      if (!TAIL_LIMITS.has(limit)) return context.json({ ok: false, error: "Invalid tail limit." }, 400);
      const handle = await fs.open(AGENT_LOG_PATH, fsConstants.O_RDONLY);
      const stats = await handle.stat();
      try {
        const size = Math.min(stats.size, MAX_TAIL_SCAN_BYTES);
        const buf = Buffer.alloc(size);
        if (size) await handle.read(buf, 0, size, stats.size - size);
        const text = buf.toString("utf8");
        const truncated = stats.size > size;
        const lines = text.replace(/\r/g, "").split("\n");
        if (lines.at(-1) === "") lines.pop();
        return context.json({ ok: true, ...boundedOutput(lines.slice(-limit).map(boundedLine), truncated) });
      } finally { await handle.close(); }
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.post("/api/v1/symbio-logs/agent/search", async (context) => {
    try {
      const { query } = await context.req.parseBody();
      if (typeof query !== "string" || !query || query.length > 500) return context.json({ ok: false, error: "Search query must contain 1-500 characters." }, 400);
      const AGENT_LOG_PATH = "/data/logs/agent.log";
      const handle = await fs.open(AGENT_LOG_PATH, fsConstants.O_RDONLY);
      const stats = await handle.stat();
      try {
        const searchBytes = 8 * 1024 * 1024;
        const size = Math.min(stats.size, searchBytes);
        const buf = Buffer.alloc(size);
        if (size) await handle.read(buf, 0, size, stats.size - size);
        const text = buf.toString("utf8");
        const lines = text.replace(/\r/g, "").split("\n");
        const matches = [];
        lines.forEach((line, index) => { if (line.includes(query)) matches.push(index); });
        const selected = matches.slice(-SEARCH_MATCH_LIMIT);
        const blocks = selected.map((matchIndex, occurrence) => {
          const start = Math.max(0, matchIndex - SEARCH_CONTEXT_LINES);
          const end = Math.min(lines.length, matchIndex + SEARCH_CONTEXT_LINES + 1);
          const contextLines = lines.slice(start, end).map((line, index) => `${start + index === matchIndex ? ">" : " "} ${line}`);
          return [`Occurrence ${occurrence + 1}/${selected.length}`, `Query: ${query}`, "----------------------------------------", ...contextLines].join("\n");
        });
        return context.json({ ok: true, ...boundedOutput(blocks, stats.size > searchBytes) });
      } finally { await handle.close(); }
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- File manager operations (new) ----
  app.get("/api/v1/files/list", async (context) => {
    try {
      const dirPath = context.req.query("path") || "/";
      const showHidden = context.req.query("showHidden") === "1";
      const result = await listDirectory(config.hostRootPath, dirPath, showHidden);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.get("/api/v1/files/read", async (context) => {
    try {
      const filePath = context.req.query("path");
      if (!filePath) throw new Error("File path is required.");
      const maxBytes = Number(context.req.query("maxBytes")) || undefined;
      const result = await readFileContent(config.hostRootPath, filePath, maxBytes);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.get("/api/v1/files/tree", async (context) => {
    try {
      const dirPath = context.req.query("path") || "/";
      const result = await getDirectoryTree(config.hostRootPath, dirPath);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- File viewer (read-only, text only, 100KB max) ----
  app.get("/api/v1/files/view", async (context) => {
    try {
      const filePath = context.req.query("path");
      if (!filePath) throw new Error("File path is required.");
      const result = await viewFileContent(config.hostRootPath, filePath);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- File write operations ----

  app.post("/api/v1/files/create", async (context) => {
    try {
      const { dirPath, name, type } = await context.req.json();
      if (type === "directory") {
        const result = await createDirectory(config.hostRootPath, dirPath || "/", name);
        return context.json({ ok: true, ...result });
      }
      const result = await createFile(config.hostRootPath, dirPath || "/", name);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.post("/api/v1/files/write", async (context) => {
    try {
      const { path: filePath, content } = await context.req.json();
      if (!filePath) throw new Error("File path is required.");
      const result = await writeFile(config.hostRootPath, filePath, content || "");
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.post("/api/v1/files/delete", async (context) => {
    try {
      const { path: filePath } = await context.req.json();
      if (!filePath) throw new Error("File path is required.");
      const result = await deleteFileOrDir(config.hostRootPath, filePath);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.post("/api/v1/files/rename", async (context) => {
    try {
      const { from, to } = await context.req.json();
      if (!from || !to) throw new Error("Source and destination paths are required.");
      const result = await renameFileOrDir(config.hostRootPath, from, to);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  app.post("/api/v1/files/chmod", async (context) => {
    try {
      const { path: filePath, mode } = await context.req.json();
      if (!filePath) throw new Error("File path is required.");
      const result = await changeMode(config.hostRootPath, filePath, mode);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- System operations (on-demand host inspection) ----
  app.get("/api/v1/system/info", async (context) => {
    try { return context.json({ ok: true, ...(await getServerInfo()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/processes", async (context) => {
    try { return context.json({ ok: true, ...(await getProcessList()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/ports", async (context) => {
    try { return context.json({ ok: true, ...(await getListeningPorts()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/memory", async (context) => {
    try { return context.json({ ok: true, ...(await getMemoryDetail()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/disk-io", async (context) => {
    try { return context.json({ ok: true, ...(await getDiskIO()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/users", async (context) => {
    try { return context.json({ ok: true, ...(await getLoggedInUsers()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  app.get("/api/v1/system/packages", async (context) => {
    try { return context.json({ ok: true, ...(await getInstalledPackages()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });
  // Returns top CPU-consuming and memory-consuming processes for alert diagnostics
  app.get("/api/v1/system/top-processes", async (context) => {
    try { return context.json({ ok: true, ...(await getTopProcesses()) }); }
    catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  // ---- Service component bridge routes ----
  serviceRegistry.registerRoutes(app);

  // ---- Skill system endpoints ----

  /** Bulk data collection for skills. Returns requested data types in one response. */
  app.post("/api/v1/skills/collect", async (context) => {
    try {
      const body = await context.req.json();
      const result = await collectSkillData(config, body.collect || [], body.options || {});
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  /** Execute whitelisted skill actions. Each action is validated and runs via execFile. */
  app.post("/api/v1/skills/execute", async (context) => {
    try {
      const body = await context.req.json();
      const actions = Array.isArray(body.actions) ? body.actions : [];
      const results = [];
      for (const action of actions) {
        const handler = ACTION_HANDLERS[action.action];
        if (!handler) { results.push({ action: action.action, status: "failed", error: "Unknown action type" }); continue; }
        try {
          const start = Date.now();
          const result = await handler.execute(action.params || {});
          results.push({ action: action.action, ...result, durationMs: Date.now() - start });
        } catch (error) {
          results.push({ action: action.action, status: "failed", error: error.message });
        }
      }
      return context.json({ ok: true, results });
    } catch (error) { return context.json({ ok: false, error: error.message }, 400); }
  });

  return app;
};
