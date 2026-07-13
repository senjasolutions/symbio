/** Starts the read-only collector, its loopback diagnostic API, and the single bridge API. */

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
  server.close(async () => {
    bridgeServer.close(async () => { await sequelize.close(); process.exit(0); });
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
