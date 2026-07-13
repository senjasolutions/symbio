/**
 * Explicit, ordered migrations make schema changes reviewable and prevent
 * Sequelize from changing production tables implicitly.
 */

import { QueryTypes } from "sequelize";
import { sequelize } from "./index.js";

const SERVICE_DEFINITIONS = [
  ["docker", "Docker"],
  ["pm2", "PM2"],
  ["mysql", "MySQL / MariaDB"],
  ["postgresql", "PostgreSQL"],
  ["redis", "Redis"],
  ["nginx", "Nginx"],
  ["apache", "Apache"],
];

const migrations = [
  {
    version: 1,
    name: "initial phase one schema",
    /** Creates normalized entity, history, authentication, and report tables. */
    up: async (transaction) => {
      const statements = [
        `CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'superadmin' CHECK (role = 'superadmin'),
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        )`,
        `CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_token TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          last_seen_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL
        )`,
        `CREATE INDEX idx_sessions_expiry ON sessions(expires_at)`,
        `CREATE TABLE servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          hostname TEXT,
          primary_ip TEXT,
          operating_system TEXT,
          kernel_version TEXT,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        )`,
        `CREATE TABLE agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
          agent_key TEXT NOT NULL UNIQUE,
          last_seen_at DATETIME,
          last_config_version INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        )`,
        `CREATE TABLE agent_reports (
          id TEXT PRIMARY KEY,
          agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          observed_at DATETIME NOT NULL,
          received_at DATETIME NOT NULL
        )`,
        `CREATE INDEX idx_agent_reports_received ON agent_reports(received_at)`,
        `CREATE TABLE server_statuses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          report_id TEXT NOT NULL REFERENCES agent_reports(id) ON DELETE CASCADE,
          cpu_percent REAL,
          memory_used_bytes INTEGER,
          memory_total_bytes INTEGER,
          memory_percent REAL,
          disk_used_bytes INTEGER,
          disk_total_bytes INTEGER,
          disk_percent REAL,
          load_1 REAL,
          load_5 REAL,
          load_15 REAL,
          uptime_seconds INTEGER,
          observed_at DATETIME NOT NULL,
          received_at DATETIME NOT NULL
        )`,
        `CREATE INDEX idx_server_status_time ON server_statuses(server_id, observed_at DESC)`,
        `CREATE TABLE server_services (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          display_name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          configuration TEXT NOT NULL DEFAULT '{}',
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          UNIQUE(server_id, type)
        )`,
        `CREATE TABLE server_service_statuses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_service_id INTEGER NOT NULL REFERENCES server_services(id) ON DELETE CASCADE,
          report_id TEXT NOT NULL REFERENCES agent_reports(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('operational','detected','degraded','unavailable','not_detected','unknown')),
          evidence TEXT NOT NULL,
          description TEXT,
          response_time_ms INTEGER,
          observed_at DATETIME NOT NULL
        )`,
        `CREATE INDEX idx_service_status_time ON server_service_statuses(server_service_id, observed_at DESC)`,
        `CREATE TABLE applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          health_check_method TEXT NOT NULL DEFAULT 'http' CHECK (health_check_method = 'http'),
          health_check_url TEXT NOT NULL,
          health_check_timeout_ms INTEGER NOT NULL DEFAULT 5000,
          slow_threshold_ms INTEGER NOT NULL DEFAULT 1500,
          response_text_match TEXT,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          deleted_at DATETIME
        )`,
        `CREATE TABLE application_statuses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          report_id TEXT NOT NULL REFERENCES agent_reports(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('up','slow','down')),
          status_code INTEGER,
          response_time_ms INTEGER,
          final_url TEXT,
          failure_reason TEXT,
          observed_at DATETIME NOT NULL
        )`,
        `CREATE INDEX idx_application_status_time ON application_statuses(application_id, observed_at DESC)`,
        `CREATE TABLE application_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        )`,
        `CREATE TABLE application_tag_assignments (
          application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          application_tag_id INTEGER NOT NULL REFERENCES application_tags(id) ON DELETE RESTRICT,
          PRIMARY KEY(application_id, application_tag_id)
        )`,
        `CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME NOT NULL
        )`,
      ];
      for (const statement of statements) {
        await sequelize.query(statement, { transaction });
      }
    },
  },
  {
    version: 2,
    name: "seed main server and known services",
    /** Seeds stable single-server identities instead of using nullable foreign keys. */
    up: async (transaction) => {
      const now = new Date().toISOString();
      await sequelize.query(
        "INSERT INTO servers (slug, display_name, created_at, updated_at) VALUES ('main-server', 'Main Server', ?, ?)",
        { replacements: [now, now], transaction },
      );
      const [server] = await sequelize.query(
        "SELECT id FROM servers WHERE slug = 'main-server'",
        { type: QueryTypes.SELECT, transaction },
      );
      await sequelize.query(
        "INSERT INTO agents (server_id, agent_key, last_config_version, created_at, updated_at) VALUES (?, 'main-agent', 1, ?, ?)",
        { replacements: [server.id, now, now], transaction },
      );
      for (const [type, displayName] of SERVICE_DEFINITIONS) {
        await sequelize.query(
          "INSERT INTO server_services (server_id, type, display_name, enabled, configuration, created_at, updated_at) VALUES (?, ?, ?, 1, '{}', ?, ?)",
          { replacements: [server.id, type, displayName, now, now], transaction },
        );
      }
      await sequelize.query(
        "INSERT INTO settings (key, value, updated_at) VALUES ('language', 'en', ?)",
        { replacements: [now], transaction },
      );
    },
  },
  {
    version: 3,
    name: "add host inventory and enriched metric samples",
    /** Keeps new report fields optional so queued Phase 1 reports remain ingestible. */
    up: async (transaction) => {
      const statements = [
        "ALTER TABLE servers ADD COLUMN hardware_json TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE servers ADD COLUMN storage_json TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE servers ADD COLUMN network_json TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE server_statuses ADD COLUMN cpu_cores_json TEXT",
        "ALTER TABLE server_statuses ADD COLUMN memory_available_bytes INTEGER",
        "ALTER TABLE server_statuses ADD COLUMN swap_used_bytes INTEGER",
        "ALTER TABLE server_statuses ADD COLUMN swap_total_bytes INTEGER",
      ];
      for (const statement of statements) await sequelize.query(statement, { transaction });
    },
  },
  {
    version: 4,
    name: "add registered application log sources",
    /** Stores configuration only; log content stays on the host and is never persisted. */
    up: async (transaction) => {
      await sequelize.query(`CREATE TABLE application_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        tail_lines INTEGER NOT NULL DEFAULT 200 CHECK (tail_lines IN (50, 100, 200, 500, 1000)),
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_application_logs_application ON application_logs(application_id, id)", { transaction });
    },
  },
  {
    version: 5,
    name: "add registered application source directories for file manager shortcuts",
    /** One application may own multiple source directories; each serves as a
     * bookmark into the read-only file manager so users can browse app files
     * without navigating the full filesystem tree each time. */
    up: async (transaction) => {
      await sequelize.query(`CREATE TABLE application_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_application_sources_application ON application_sources(application_id, id)", { transaction });
    },
  },
];

/** Applies each unapplied migration in its own transaction and records success. */
export const runMigrations = async () => {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME NOT NULL
  )`);
  const applied = await sequelize.query("SELECT version FROM schema_migrations", { type: QueryTypes.SELECT });
  const versions = new Set(applied.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    await sequelize.transaction(async (transaction) => {
      await migration.up(transaction);
      await sequelize.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        { replacements: [migration.version, migration.name, new Date().toISOString()], transaction },
      );
    });
  }
};
