/** Starts the read-only collector, its loopback diagnostic API, and the single bridge API. */

import { readFileSync } from "node:fs";

// Detect host timezone from mounted /etc/timezone
(function detectTimezone() {
  try {
    const tz = readFileSync("/etc/timezone", "utf8").trim();
    if (tz) { process.env.TZ = tz; console.log("Timezone:", tz); }
  } catch {}
})();

// Prevent silent crashes — log and exit cleanly
process.on("unhandledRejection", (reason) => {
  console.error("Agent unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("Agent uncaught exception:", err.message);
  process.exit(1);
});

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createAgentApp, createAgentBridgeApp } from "./app.js";
import { connectAgentDatabase, sequelize } from "./db.js";
import { startWorker, stopWorker } from "./worker.js";

if (!config.agentToken) throw new Error("SYMBIO agent token is not configured.");
if (!Number.isInteger(config.healthPort) || config.healthPort < 1 || config.healthPort > 65535) throw new Error("Invalid agent health port.");
if (!Number.isInteger(config.bridgePort) || config.bridgePort < 1 || config.bridgePort > 65535) throw new Error("Invalid agent bridge port.");

await connectAgentDatabase();
const server = serve({ fetch: createAgentApp().fetch, port: config.healthPort, hostname: "127.0.0.1" });
const bridgeServer = serve({ fetch: createAgentBridgeApp().fetch, port: config.bridgePort, hostname: config.bridgeHost });
console.log(`Symbio agent diagnostic API listening on 127.0.0.1:${config.healthPort}`);
console.log(`Symbio agent bridge API listening on ${config.bridgeHost}:${config.bridgePort}`);
startWorker().catch((error) => { console.error("Symbio agent failed to start:", error.message); process.exit(1); });

/** Stops monitoring before closing Hono and SQLite. */
const shutdown = () => {
  stopWorker();
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => {
    bridgeServer.close(async () => {
      clearTimeout(forceExit);
      await sequelize.close();
      process.exit(0);
    });
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
