/**
 * Mothership-to-agent Nginx client reads nginx config info (modules, sites)
 * over the authenticated bridge.
 */

import { config } from "../config.js";

const agentFetch = async (path) => {
  let response;
  try {
    response = await fetch(`${config.agentBridgeUrl}${path}`, {
      headers: { authorization: `Bearer ${config.agentToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Nginx agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Nginx request failed.");
  return payload;
};

export const fetchNginxInfo = () => agentFetch("/api/v1/services/nginx/info");
