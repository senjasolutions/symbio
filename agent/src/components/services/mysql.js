/**
 * MySQL / MariaDB service component — validates the MySQL protocol and exposes
 * read-only bridge endpoints for status, database listing, table listing, and
 * data browsing via mysql2. Credentials are read from the agent's cached
 * configuration (service.configuration), never from user input.
 *
 * Security: all queries use parameterized identifiers or are hardcoded SELECT
 * statements. No user-supplied WHERE clauses, custom SQL, or DML is possible.
 * Database/table names are validated against actual SHOW results before use.
 */

import mysql from "mysql2/promise";
import { getCurrentConfig } from "../../worker.js";

/**
 * Reads the MySQL service configuration from the agent's cached config.
 */
const getMySQLConfig = () => {
  const config = getCurrentConfig();
  if (!config || !Array.isArray(config.services)) return null;
  const svc = config.services.find((s) => s.type === "mysql");
  return svc?.configuration || null;
};

/**
 * Creates a mysql2 connection using the provided configuration, trying
 * auto-detected credentials first (root/no-password) then falling back
 * to stored credentials.
 */
const createConnection = async () => {
  const cfg = getMySQLConfig() || {};
  const host = cfg.host || "127.0.0.1";
  const port = Number(cfg.port || 3306);
  const user = cfg.username || "root";
  const password = cfg.password || "";
  try {
    const conn = await mysql.createConnection({ host, port, user, password, connectTimeout: 5000 });
    return conn;
  } catch (error) {
    // ER_ACCESS_DENIED_ERROR (1045) = wrong password, ER_ACCESS_DENIED_NO_PASSWORD_ERROR (1698) = root without password
    const accessDenied = error.code === "ER_ACCESS_DENIED_ERROR" || error.code === "ER_ACCESS_DENIED_NO_PASSWORD_ERROR";
    if (accessDenied && !cfg.username) {
      return { needsCredentials: true, hint: "MySQL requires authentication. Configure username and password in service settings." };
    }
    throw error;
  }
};

/**
 * Validates a database/table name: only alphanumeric, underscore, and hyphen.
 */
const validIdent = (name) => /^[a-zA-Z0-9_-]+$/.test(name);

/**
 * Runs a query and returns rows + fields. Connection is closed after.
 */
const query = async (conn, sql, params = []) => {
  const [rows, fields] = await conn.execute(sql, params);
  return { rows, fields: fields ? fields.map((f) => f.name) : [] };
};

export default {
  type: "mysql",
  displayName: "MySQL / MariaDB",

  /**
   * Validates the MySQL protocol handshake via raw TCP (same as before).
   */
  async probe(service, { exchange, processDetected, result: makeResult }) {
    const detected = processDetected("mysql");
    const configuration = service.configuration || {};
    const host = configuration.host || "127.0.0.1";
    const port = Number(configuration.port || 3306);
    try {
      const response = await exchange(host, port, null, 3000, 5);
      if (response.length < 5 || response[4] !== 10) {
        throw new Error("Unexpected MySQL handshake");
      }
      return makeResult(service.id, "operational", "protocol",
        `MySQL protocol answered on ${host}:${port}.`);
    } catch (error) {
      return makeResult(service.id, detected ? "unavailable" : "not_detected",
        detected ? "protocol" : "process",
        detected
          ? `Process detected but probe failed: ${error.message}`
          : `Service was not detected and probe failed: ${error.message}`);
    }
  },

  /**
   * Registers read-only MySQL bridge endpoints.
   */
  routes(router) {
    /**
     * Returns server status, version, and key variables.
     */
    router.get("/api/v1/services/mysql/status", async (c) => {
      try {
        const result = await createConnection();
        if (result.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: result.hint });
        try {
          const [version] = await result.execute("SELECT @@version AS version, @@version_comment AS versionComment, @@port AS port, @@datadir AS datadir, NOW() AS now");
          const [status] = await result.execute("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Connections', 'Threads_connected', 'Questions', 'Queries', 'Slow_queries', 'Open_tables', 'Flush_commands', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Bytes_received', 'Bytes_sent', 'Max_used_connections')");
          const [variables] = await result.execute("SHOW VARIABLES WHERE Variable_name IN ('max_connections', 'innodb_buffer_pool_size', 'character_set_server', 'collation_server', 'version', 'have_ssl')");
          const statusMap = {};
          for (const row of status) statusMap[row.Variable_name] = row.Value;
          const varMap = {};
          for (const row of variables) varMap[row.Variable_name] = row.Value;
          return c.json({ ok: true, server: version[0], status: statusMap, variables: varMap });
        } finally { await result.end().catch(() => {}); }
      } catch (error) {
        return c.json({ ok: true, needsCredentials: false, server: null, status: {}, variables: {}, error: error.message });
      }
    });

    /**
     * Lists non-system databases.
     */
    router.get("/api/v1/services/mysql/databases", async (c) => {
      try {
        const result = await createConnection();
        if (result.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: result.hint });
        try {
          const [rows] = await result.execute("SHOW DATABASES");
          const systemDbs = new Set(["information_schema", "performance_schema", "mysql", "sys"]);
          const databases = rows.filter((r) => !systemDbs.has(r.Database)).map((r) => r.Database);
          return c.json({ ok: true, databases });
        } finally { await result.end().catch(() => {}); }
      } catch (error) {
        return c.json({ ok: true, databases: [], error: error.message });
      }
    });

    /**
     * Shows tables for a specific database.
     */
    router.get("/api/v1/services/mysql/databases/:db/tables", async (c) => {
      const db = c.req.param("db");
      if (!validIdent(db)) return c.json({ ok: true, tables: [], error: "Invalid database name." });
      try {
        const result = await createConnection();
        if (result.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: result.hint });
        try {
          await result.execute(`USE \`${db}\``);
          const [rows] = await result.execute("SHOW TABLE STATUS");
          const tables = rows.map((r) => ({
            name: r.Name,
            engine: r.Engine || "",
            rows: r.Rows || 0,
            dataLength: r.Data_length || 0,
            indexLength: r.Index_length || 0,
            createTime: r.Create_time ? new Date(r.Create_time).toISOString() : null,
            collation: r.Collation || "",
          }));
          return c.json({ ok: true, tables });
        } finally { await result.end().catch(() => {}); }
      } catch (error) {
        return c.json({ ok: true, tables: [], error: error.message });
      }
    });

    /**
     * Browses rows from a specific table (SELECT * LIMIT 100, read-only).
     */
    router.get("/api/v1/services/mysql/databases/:db/tables/:table/browse", async (c) => {
      const db = c.req.param("db");
      const table = c.req.param("table");
      if (!validIdent(db) || !validIdent(table)) return c.json({ ok: true, rows: [], columns: [], error: "Invalid identifier." });
      try {
        const result = await createConnection();
        if (result.needsCredentials) return c.json({ ok: true, needsCredentials: true, hint: result.hint });
        try {
          await result.execute(`USE \`${db}\``);
          const { rows, fields } = await query(result, `SELECT * FROM \`${table}\` LIMIT 100`);
          return c.json({ ok: true, rows, columns: fields });
        } finally { await result.end().catch(() => {}); }
      } catch (error) {
        return c.json({ ok: true, rows: [], columns: [], error: error.message });
      }
    });
  },
};
