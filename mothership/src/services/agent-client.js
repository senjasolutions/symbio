/**
 * Agent bridge HTTP client — calls the agent's skills endpoints.
 * The agent is reachable at the Docker bridge on port 18768.
 * All requests use Bearer token authentication.
 * Token is read from file (SYMBIO_AGENT_TOKEN_FILE) or env var (SYMBIO_AGENT_TOKEN)
 * with the same readSecret mechanism as config.js to prevent 401s.
 */

import { readFileSync } from "node:fs";

const readSecret = (path, fallback = "") => {
  try { return readFileSync(path, "utf8").trim(); } catch { return fallback; }
};

const AGENT_URL = process.env.SYMBIO_AGENT_BRIDGE_URL || process.env.SYMBIO_AGENT_URL || "http://host.docker.internal:18768";
const AGENT_TOKEN = readSecret(
  process.env.SYMBIO_AGENT_TOKEN_FILE || "/run/secrets/agent_token",
  process.env.SYMBIO_AGENT_TOKEN || "",
);

/** Sends a POST request to the agent bridge with JSON body and Bearer token. */
const post = async (path, body) => {
  const response = await fetch(`${AGENT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AGENT_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Agent bridge error (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
};

/** Collects requested data types from the agent for skills. */
export const collectSkillData = async (types, options = {}) => {
  return post("/api/v1/skills/collect", { collect: types, options });
};

/** Executes whitelisted actions on the agent. */
export const executeSkillActions = async (actions) => {
  return post("/api/v1/skills/execute", { actions });
};
