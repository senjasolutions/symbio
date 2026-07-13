/** Starts both isolated Hono listeners after migrations complete successfully. */

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createInternalApp, createPublicApp } from "./app.js";
import { closeDatabase, connectDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrations.js";
import { deleteExpiredSessions } from "./lib/auth.js";
import { cleanupHistory } from "./services/report.service.js";

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
  } catch (error) {
    console.error("Symbio maintenance failed:", error instanceof Error ? error.message : error);
  }
};
const maintenanceTimer = setInterval(maintenance, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();
await maintenance();

/** Stops listeners before closing SQLite so in-flight requests cannot use a closed database. */
const shutdown = () => {
  clearInterval(maintenanceTimer);
  publicServer.close(() => {
    internalServer.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
