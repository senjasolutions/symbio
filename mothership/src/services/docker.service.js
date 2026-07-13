/**
 * Mothership-to-agent Docker client reads live container, volume, and network
 * inventory on demand. Every call crosses the authenticated agent bridge;
 * no Docker command originates from the browser.
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
    throw new Error("Docker agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Docker request failed.");
  return payload;
};

export const fetchDockerContainers = () => agentFetch("/api/v1/services/docker/containers");
export const fetchDockerContainer = (id) => agentFetch(`/api/v1/services/docker/containers/${encodeURIComponent(id)}`);
export const fetchDockerVolumes = () => agentFetch("/api/v1/services/docker/volumes");
export const fetchDockerNetworks = () => agentFetch("/api/v1/services/docker/networks");
