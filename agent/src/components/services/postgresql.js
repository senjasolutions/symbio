/**
 * PostgreSQL service component — validates the SSL negotiation response and
 * exposes read-only bridge endpoints for server status, database listing,
 * schema/table browsing, and data queries via pg (node-postgres).
 *
 * Security: all queries are read-only SELECT statements executed via
 * parameterized queries. No user-supplied WHERE clauses or DML are possible.
 */

import pg from "pg";
import { getCurrentConfig } from "../../worker.js";

const { Client } = pg;

/**
 * Reads PostgreSQL service configuration from the agent's cached config.
 */
const getPGConfig = () => {
  const config = getCurrentConfig();
  if (!config || !Array.isArray(config.services)) return null;
  const svc = config.services.find((s) => s.type === "postgresql");
  return svc?.configuration || null;
};

/**
 * Creates a pg Client connected to the specified database.
 */
const createClient = async (database = "postgres") => {
  const cfg = getPGConfig() || {};
  const host = cfg.host || "127.0.0.1";
  const port = Number(cfg.port || 5432);
  const user = cfg.username || "postgres";
  const password = cfg.password || "";
  const client = new Client({ host, port, user, password, database, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") throw error;
    if (error.code === "28P01" || error.message.includes("password")) {
      // Authentication failed
      if (!cfg.username) {
        return { needsCredentials: true, hint: "PostgreSQL requires a username and password. Use a root or full-access account — the agent only performs read operations." };
      }
      throw error;
    }
    throw error;
  }
};

/**
 * Validates an identifier (database, schema, table name).
 */
const validIdent = (name) => /^[a-zA-Z0-9_$]+$/.test(name) && name.length <= 63;

export default {
  type: "postgresql",
  displayName: "PostgreSQL",

  /**
   * Validates the PostgreSQL protocol via SSL negotiation response.
   */
  async probe(service, { exchange, processDetected, result: makeResult }) {
    const detected = processDetected("postgresql");
    const configuration = service.configuration || {};
    const host = configuration.host || "127.0.0.1";
    const port = Number(configuration.port || 5432);
    try {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      const response = await exchange(host, port, request);
      if (!response.length || !new Set(["S", "N"]).has(response.subarray(0, 1).toString())) {
        throw new Error("Unexpected PostgreSQL negotiation response");
      }
      return makeResult(service.id, "operational", "protocol",
        `PostgreSQL protocol answered on ${host}:${port}.`);
    } catch (error) {
      return makeResult(service.id, detected ? "unavailable" : "not_detected",
        detected ? "protocol" : "process",
        detected
          ? `Process detected but probe failed: ${error.message}`
          : `Service was not detected and probe failed: ${error.message}`);
    }
  },

  /**
   * Registers read-only PostgreSQL bridge endpoints.
   */
  routes(router) {
    /** Returns server version, uptime, active connections, and key settings. */
    router.get("/api/v1/services/postgresql/status", async (c) => {
      const client = await createClient();
      if (client.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: client.hint });
      try {
        const version = await client.query("SELECT version() AS version");
        const settings = await client.query("SELECT name, setting, unit FROM pg_settings WHERE name IN ('server_version', 'max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'port', 'data_directory', 'listen_addresses', 'ssl', 'transaction_isolation', 'server_encoding', 'lc_collate', 'lc_ctype')");
        const stats = await client.query("SELECT numbackends AS active_connections, xact_commit + xact_rollback AS total_transactions, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = 'postgres'");
        const uptime = await client.query("SELECT pg_postmaster_start_time() AS start_time, NOW() - pg_postmaster_start_time() AS uptown_interval");
        return c.json({ ok: true, server: version.rows[0], settings: settings.rows, stats: stats.rows[0], uptime: uptime.rows[0] });
      } finally { await client.end().catch(() => {}); }
    });

    /** Lists non-template databases. */
    router.get("/api/v1/services/postgresql/databases", async (c) => {
      const client = await createClient();
      if (client.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: client.hint });
      try {
        const result = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
        const databases = result.rows.map((r) => r.datname);
        return c.json({ ok: true, databases });
      } finally { await client.end().catch(() => {}); }
    });

    /** Lists tables in a specific database with schema info. */
    router.get("/api/v1/services/postgresql/databases/:db/tables", async (c) => {
      const db = c.req.param("db");
      if (!validIdent(db)) return c.json({ ok: true, tables: [], error: "Invalid database name." });
      const client = await createClient(db);
      if (client.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: client.hint });
      try {
        const result = await client.query(`
          SELECT table_schema, table_name, table_type,
                 (SELECT pg_size_pretty(pg_total_relation_size(quote_ident(table_schema) || '.' || quote_ident(table_name)))) AS size,
                 (SELECT reltuples::bigint FROM pg_class WHERE oid = (quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass) AS row_estimate
          FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name
        `);
        const tables = result.rows.map((r) => ({
          schema: r.table_schema,
          name: r.table_name,
          type: r.table_type || "TABLE",
          size: r.size || "",
          rowEstimate: r.row_estimate || 0,
        }));
        return c.json({ ok: true, tables });
      } finally { await client.end().catch(() => {}); }
    });

    /** Browses rows from a table (SELECT * LIMIT 100). */
    router.get("/api/v1/services/postgresql/databases/:db/schemas/:schema/tables/:table/browse", async (c) => {
      const db = c.req.param("db");
      const schema = c.req.param("schema");
      const table = c.req.param("table");
      if (!validIdent(db) || !validIdent(schema) || !validIdent(table)) {
        return c.json({ ok: true, rows: [], columns: [], error: "Invalid identifier." });
      }
      const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
      const search = (c.req.query("search") || "").trim();
      const perPage = 100;
      const offset = (page - 1) * perPage;
      const client = await createClient(db);
      if (client.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: client.hint });
      try {
        let whereClause = "";
        const countParams = [];
        const dataParams = [];
        if (search) {
          whereClause = ` WHERE CAST(t.* AS TEXT) ILIKE $1`;
          countParams.push(`%${search}%`);
          dataParams.push(`%${search}%`);
        }
        // Get total count
        const countResult = await client.query(
          `SELECT COUNT(*) AS total FROM "${schema}"."${table}" t${whereClause}`, countParams
        );
        const total = parseInt(countResult.rows[0].total, 10);
        // Get page of data
        dataParams.push(perPage, offset);
        const result = await client.query(
          `SELECT * FROM "${schema}"."${table}" t${whereClause} LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
          dataParams
        );
        const columns = result.fields.map((f) => f.name);
        return c.json({ ok: true, rows: result.rows, columns, total, page, perPage });
      } finally { await client.end().catch(() => {}); }
    });
  },
};
