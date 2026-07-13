/**
 * Mothership-to-agent MySQL client reads live database status, schema, and
 * table data over the authenticated bridge. All operations are read-only.
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
    throw new Error("MySQL agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "MySQL request failed.");
  return payload;
};

export const fetchMySQLStatus = () => agentFetch("/api/v1/services/mysql/status");
export const fetchMySQLDatabases = () => agentFetch("/api/v1/services/mysql/databases");
export const fetchMySQLTables = (db) => agentFetch(`/api/v1/services/mysql/databases/${encodeURIComponent(db)}/tables`);
export const fetchMySQLBrowse = (db, table, page = 1, search = "") => {
  let url = `/api/v1/services/mysql/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/browse?page=${page}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  return agentFetch(url);
};
