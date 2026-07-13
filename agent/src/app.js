/** Private loopback Hono API exposes only local health and sanitized worker state. */

import { Hono } from "hono";
import { OutboxReport } from "./db.js";
import { workerState, refreshConfiguration, getCurrentConfig } from "./worker.js";
import { config } from "./config.js";
import { readRegisteredTail, searchRegisteredLog } from "./log-reader.js";
import { listDirectory, readFileContent, getDirectoryTree } from "./file-manager.js";
import { viewFileContent } from "./file-manager.js";
import { getServerInfo, getProcessList, getListeningPorts, getMemoryDetail, getDiskIO, getLoggedInUsers, getInstalledPackages } from "./system.js";
import { serviceRegistry } from "./components/services/index.js";

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
    if (context.req.header("authorization") !== `Bearer ${config.agentToken}`)
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

  // ---- Service component bridge routes ----
  serviceRegistry.registerRoutes(app);

  return app;
};
