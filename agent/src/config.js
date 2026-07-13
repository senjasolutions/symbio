/** Agent configuration validates runtime paths, intervals, and private endpoints in one place. */

import fs from "node:fs";

/** Reads a mounted token without exposing it through command-line arguments. */
const readSecret = (path, fallback = "") => {
  try { return fs.readFileSync(path, "utf8").trim(); } catch { return fallback; }
};

export const config = Object.freeze({
  databasePath: process.env.SYMBIO_AGENT_DATABASE_PATH || "/data/agent.sqlite",
  procPath: process.env.SYMBIO_HOST_PROC || "/host/proc",
  osReleasePath: process.env.SYMBIO_HOST_OS_RELEASE || "/host/etc/os-release",
  hostnamePath: process.env.SYMBIO_HOST_HOSTNAME || "/host/etc/hostname",
  // This read-only root bind is used to stat host mount points, read interface
  // facts, browse the file manager, and tail registered logs. The agent exposes
  // no shell, no write, and no path input from the browser.
  hostRootPath: process.env.SYMBIO_HOST_ROOT || "/host/root",
  serverIp: process.env.SYMBIO_SERVER_IP || "",
  mothershipUrl: process.env.SYMBIO_MOTHERSHIP_URL || "http://127.0.0.1:18766/internal/v1",
  healthPort: Number(process.env.SYMBIO_AGENT_HEALTH_PORT || 18767),
  // Single bridge port serves log reader, file manager, and any future
  // mothership-facing agent capabilities through one token-authenticated API.
  bridgePort: Number(process.env.SYMBIO_AGENT_BRIDGE_PORT || 18768),
  bridgeHost: process.env.SYMBIO_AGENT_BRIDGE_IP || "172.17.0.1",
  agentId: "main-agent",
  agentToken: readSecret(
    process.env.SYMBIO_AGENT_TOKEN_FILE || "/run/secrets/agent_token",
    process.env.SYMBIO_AGENT_TOKEN || "",
  ),
});
