/**
 * Mothership-to-agent bridge client for predefined system/service logs.
 * The agent validates source slugs against a hardcoded whitelist — no
 * file path ever arrives from the browser.
 */

import { config } from "../config.js";

/** Calls the bridge-only agent API with Bearer token auth. */
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

/** Reads tail of a predefined system/service log source by slug. */
export const readSystemLog = (slug, limit) =>
  agentLogFetch(`/api/v1/system-logs/read?source=${encodeURIComponent(slug)}&limit=${encodeURIComponent(limit || 100)}`);

/** Searches a predefined system/service log source by slug. */
export const searchSystemLog = (slug, query) =>
  agentLogFetch(`/api/v1/system-logs/search?source=${encodeURIComponent(slug)}`, { method: "POST", body: JSON.stringify({ query }) });
