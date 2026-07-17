/**
 * Mothership-to-agent system client reads live host inspection data on demand.
 * Every call crosses the authenticated bridge; no host path or shell command
 * originates from the browser.
 */

import { config } from "../config.js";

const agentFetch = async (path) => {
  let response;
  try {
    response = await fetch(`${config.agentBridgeUrl}${path}`, {
      headers: { authorization: `Bearer ${config.agentToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("System agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "System request failed.");
  return payload;
};

export const fetchServerInfo = () => agentFetch("/api/v1/system/info");
export const fetchProcessList = () => agentFetch("/api/v1/system/processes");
export const fetchListeningPorts = () => agentFetch("/api/v1/system/ports");
export const fetchMemoryDetail = () => agentFetch("/api/v1/system/memory");
export const fetchDiskIO = () => agentFetch("/api/v1/system/disk-io");
export const fetchLoggedInUsers = () => agentFetch("/api/v1/system/users");
export const fetchInstalledPackages = () => agentFetch("/api/v1/system/packages");
/** Fetches top 5 CPU and memory consumers from the agent for alert diagnostics. */
export const fetchTopProcesses = () => agentFetch("/api/v1/system/top-processes");
