/**
 * PM2 service component — detects a running PM2 process and exposes a
 * live process list by reading PM2's dump file from the host filesystem.
 * The dump file (~/.pm2/dump.pm2) contains the current managed process list
 * and is updated by PM2 whenever a process starts or stops.
 *
 * Note: The pm2 npm package is intentionally NOT imported here because it has
 * side effects at module load (creates .pm2 directory structure) and attempts
 * to launch a daemon on connect(). Instead we read the dump file directly.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Known locations for PM2 dump files on the host filesystem. */
const PM2_DUMP_PATHS = [
  "/host/root/root/.pm2/dump.pm2",
  "/host/root/home/node/.pm2/dump.pm2",
  "/host/root/var/lib/pm2/.pm2/dump.pm2",
];

/**
 * Attempts to read PM2's process dump file from known locations.
 * Falls back to scanning home directories when known paths don't match
 * (common for NVM/user-level PM2 installations).
 * Returns the parsed process list or an empty array.
 */
const fetchPM2Processes = async () => {
  // First try known paths
  for (const dumpPath of PM2_DUMP_PATHS) {
    try {
      const content = await fs.readFile(dumpPath, "utf8");
      return parsePM2Dump(content);
    } catch {}
  }
  // Fallback: scan all home directories for .pm2/dump.pm2
  try {
    const homeDirs = await fs.readdir("/host/root/home");
    for (const dir of homeDirs) {
      try {
        const content = await fs.readFile(`/host/root/home/${dir}/.pm2/dump.pm2`, "utf8");
        return parsePM2Dump(content);
      } catch {}
    }
  } catch {}
  return [];
};

/** Parses PM2 dump JSON into a structured process list. */
const parsePM2Dump = (content) => {
  const parsed = JSON.parse(content);
  const rawProcesses = Array.isArray(parsed) ? parsed : (parsed.processes || []);
  return rawProcesses.map((proc) => {
    const pm2Env = proc.pm2_env || {};
    return {
      name: proc.name || pm2Env.name || "unknown",
      pid: proc.pid || null,
      status: pm2Env.status || (proc.status || "unknown"),
      uptime: pm2Env.pm_uptime || null,
      memory: pm2Env.monit?.memory || null,
      cpu: pm2Env.monit?.cpu || null,
      mode: pm2Env.exec_mode || "fork",
      restarts: pm2Env.restart_time ?? 0,
      version: pm2Env.version || null,
      instances: pm2Env.instances || 1,
    };
  });
};

export default {
  type: "pm2",
  displayName: "PM2",

  /**
   * Checks whether a PM2 process exists on the host. Returns "detected" with
   * process evidence or "not_detected" if no pm2 process is found.
   */
  async probe(service, { processDetected, result: makeResult }) {
    const detected = processDetected("pm2");
    return makeResult(service.id, detected ? "detected" : "not_detected", "process",
      detected
        ? "PM2 process detected; RPC health is not claimed."
        : "PM2 process was not detected.");
  },

  /**
   * Registers bridge endpoints for listing PM2-managed processes.
   */
  routes(router) {
    router.get("/api/v1/services/pm2/processes", async (c) => {
      try {
        const processes = await fetchPM2Processes();
        return c.json({ ok: true, processes });
      } catch (error) {
        return c.json({ ok: true, processes: [], error: error.message });
      }
    });
  },
};
