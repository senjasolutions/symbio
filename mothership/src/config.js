/**
 * Mothership configuration centralizes validated environment values so routes
 * and services do not each invent different defaults.
 */

import fs from "node:fs";

/** Converts an environment value to a bounded positive integer. */
const positiveInteger = (value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

/** Reads a Docker-style secret file without ever logging its contents. */
const readSecret = (path, fallback = "") => {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return fallback;
  }
};

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",
  publicPort: positiveInteger(process.env.PORT, 8080, 1, 65535),
  internalPort: positiveInteger(process.env.SYMBIO_INTERNAL_PORT, 8081, 1, 65535),
  databasePath: process.env.SYMBIO_DATABASE_PATH || "/data/mothership.sqlite",
  viewsPath: process.env.SYMBIO_VIEWS_PATH || new URL("./views", import.meta.url).pathname,
  cookieSecure: process.env.SYMBIO_COOKIE_SECURE === "1",
  sessionHours: positiveInteger(process.env.SYMBIO_SESSION_HOURS, 12, 1, 168),
  retentionDays: positiveInteger(process.env.SYMBIO_RETENTION_DAYS, 7, 1, 90),
  // Single bridge port serves log reader, file manager, and all future
  // mothership-facing agent capabilities through one token-authenticated API.
  agentBridgeUrl: process.env.SYMBIO_AGENT_BRIDGE_URL || "http://host.docker.internal:18768",
  agentToken: readSecret(
    process.env.SYMBIO_AGENT_TOKEN_FILE || "/run/secrets/agent_token",
    process.env.SYMBIO_AGENT_TOKEN || "",
  ),
});
