/**
 * Mothership-to-agent PM2 client reads live process list over the
 * authenticated bridge.
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
    throw new Error("PM2 agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "PM2 request failed.");
  return payload;
};

export const fetchPM2Processes = () => agentFetch("/api/v1/services/pm2/processes");
