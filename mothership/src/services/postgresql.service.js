/**
 * Mothership-to-agent PostgreSQL client reads live database status, schema,
 * and table data over the authenticated bridge. All operations are read-only.
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
    throw new Error("PostgreSQL agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "PostgreSQL request failed.");
  return payload;
};

export const fetchPGStatus = () => agentFetch("/api/v1/services/postgresql/status");
export const fetchPGDatabases = () => agentFetch("/api/v1/services/postgresql/databases");
export const fetchPGTables = (db) => agentFetch(`/api/v1/services/postgresql/databases/${encodeURIComponent(db)}/tables`);
export const fetchPGBrowse = (db, schema, table) => agentFetch(`/api/v1/services/postgresql/databases/${encodeURIComponent(db)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/browse`);
