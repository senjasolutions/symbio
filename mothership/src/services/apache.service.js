/**
 * Mothership-to-agent Apache client reads Apache module and virtual host info
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
    throw new Error("Apache agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Apache request failed.");
  return payload;
};

export const fetchApacheInfo = () => agentFetch("/api/v1/services/apache/info");
