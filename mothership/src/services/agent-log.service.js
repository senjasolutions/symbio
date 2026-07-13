/**
 * Mothership-to-agent log client preserves the browser boundary: source IDs
 * and bounded options cross the bridge, never raw host paths or shell commands.
 */

import { config } from "../config.js";

/** Calls the bridge-only agent API and normalizes its truthful error payloads. */
const agentLogFetch = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`${config.agentBridgeUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${config.agentToken}`, "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error("Log agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Log agent request failed.");
  return payload;
};

/** Requests a bounded tail using one registered source ID and allowed line count. */
export const readApplicationLog = (logId, limit) => agentLogFetch(`/api/v1/logs/${logId}/tail?limit=${encodeURIComponent(limit)}`);

/** Requests literal search through the agent's bounded recent-file window. */
export const searchApplicationLog = (logId, query) => agentLogFetch(`/api/v1/logs/${logId}/search`, { method: "POST", body: JSON.stringify({ query }) });
