/** Starts both isolated Hono listeners after migrations complete successfully. */

import { readFileSync, readlinkSync } from "node:fs";

// Detect host timezone from mounted /etc/timezone or /etc/localtime symlink.
// Node.js ICU ignores /etc/localtime binary data, so we must set TZ explicitly.
(function detectTimezone() {
  try {
    const tz = readFileSync("/etc/timezone", "utf8").trim();
    if (tz) { process.env.TZ = tz; console.log("Timezone:", tz); return; }
  } catch {}
  try {
    const link = readlinkSync("/etc/localtime");
    if (link && link.includes("/")) {
      const parts = link.split("/");
      const idx = parts.indexOf("zoneinfo");
      if (idx !== -1) {
        const tz = parts.slice(idx + 1).join("/");
        if (tz && tz.length > 2) { process.env.TZ = tz; console.log("Timezone:", tz); return; }
      }
    }
  } catch {}
})();

// Prevent silent crashes — log and exit cleanly
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
  process.exit(1);
});

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createInternalApp, createPublicApp } from "./app.js";
import { closeDatabase, connectDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { deleteExpiredSessions } from "./lib/auth.js";
import { cleanupHistory, cleanupNotifications } from "./services/report.service.js";
import { initScheduler, stopScheduler } from "./services/skills/scheduler.js";
import { startAlertEngine, stopAlertEngine } from "./services/alert-engine.js";

if (!config.agentToken) throw new Error("SYMBIO agent token is not configured.");

await connectDatabase();
await runMigrations();

const publicServer = serve({ fetch: createPublicApp().fetch, port: config.publicPort, hostname: "0.0.0.0" });
const internalServer = serve({ fetch: createInternalApp().fetch, port: config.internalPort, hostname: "0.0.0.0" });

console.log(`Symbio mothership dashboard listening on 0.0.0.0:${config.publicPort}`);
console.log(`Symbio mothership agent API listening on 0.0.0.0:${config.internalPort}`);

/** Runs bounded daily maintenance without delaying request startup. */
const maintenance = async () => {
  try {
    await deleteExpiredSessions();
    await cleanupHistory();
    await cleanupNotifications();
  } catch (error) {
    console.error("Symbio maintenance failed:", error instanceof Error ? error.message : error);
  }
};
const maintenanceTimer = setInterval(maintenance, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();
await maintenance();

// Start the skill scheduler for Symbio Intelligence
initScheduler().catch((error) => console.error("Failed to start skill scheduler:", error.message));

// Start the alert engine for resource threshold monitoring
startAlertEngine().catch((error) => console.error("Failed to start alert engine:", error.message));

/** Stops all background services and cleanly exits. */
const shutdown = () => {
  clearInterval(maintenanceTimer);
  stopScheduler();
  stopAlertEngine();
  // Force exit after 5s if close callbacks don't fire
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  publicServer.close(() => {
    internalServer.close(async () => {
      clearTimeout(forceExit);
      await closeDatabase();
      process.exit(0);
    });
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
