/** Agent SQLite stores cached configuration, a bounded retry outbox, and command audit logs. */

import { Sequelize, DataTypes } from "sequelize";
import { config } from "./config.js";

export const sequelize = new Sequelize({
  dialect: "sqlite", storage: config.databasePath, logging: false,
  pool: { max: 1, min: 0, idle: 10_000 },
});

export const CachedConfig = sequelize.define("CachedConfig", {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  version: { type: DataTypes.INTEGER, allowNull: false },
  payload: { type: DataTypes.TEXT, allowNull: false },
  updatedAt: { type: DataTypes.DATE, field: "updated_at" },
}, { tableName: "cached_configs", timestamps: false });

export const OutboxReport = sequelize.define("OutboxReport", {
  id: { type: DataTypes.STRING, primaryKey: true },
  payload: { type: DataTypes.TEXT, allowNull: false },
  attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "attempt_count" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { tableName: "outbox_reports", timestamps: false });

/** Applies the small explicit agent schema and reliability pragmas. */
export const connectAgentDatabase = async () => {
  await sequelize.authenticate();
  await sequelize.query("PRAGMA journal_mode = WAL");
  await sequelize.query("PRAGMA busy_timeout = 5000");
  await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL
  )`);
  const [rows] = await sequelize.query("SELECT version FROM schema_migrations WHERE version = 1");
  if (!rows.length) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`CREATE TABLE cached_configs (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
        payload TEXT NOT NULL, updated_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query(`CREATE TABLE outbox_reports (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_outbox_created ON outbox_reports(created_at)", { transaction });
      await sequelize.query("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)", {
        replacements: [new Date().toISOString()], transaction,
      });
    });
  }

  // Migration 2: command_audit_log table (added in Phase 1 command framework)
  const [v2rows] = await sequelize.query("SELECT version FROM schema_migrations WHERE version = 2");
  if (!v2rows.length) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS command_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        parameters TEXT DEFAULT '{}',
        command TEXT NOT NULL DEFAULT '',
        stdout_snippet TEXT DEFAULT '',
        stderr_snippet TEXT DEFAULT '',
        exit_code INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'success',
        execution_time_ms INTEGER DEFAULT 0,
        triggered_by TEXT DEFAULT 'skill',
        created_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query("CREATE INDEX IF NOT EXISTS idx_audit_created ON command_audit_log(created_at)", { transaction });
      await sequelize.query("CREATE INDEX IF NOT EXISTS idx_audit_type ON command_audit_log(action_type)", { transaction });
      await sequelize.query("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)", {
        replacements: [new Date().toISOString()], transaction,
      });
    });
  }
};

/** Loads the last valid mothership configuration for offline collection. */
export const readCachedConfig = async () => {
  const row = await CachedConfig.findByPk(1);
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
};

/** Atomically replaces the single cached configuration record. */
export const writeCachedConfig = async (payload) => {
  await CachedConfig.upsert({ id: 1, version: payload.version, payload: JSON.stringify(payload), updatedAt: new Date() });
};

/** Adds one immutable report and drops oldest rows beyond the 24-hour design bound. */
export const enqueueReport = async (report) => {
  await OutboxReport.create({ id: report.id, payload: JSON.stringify(report), createdAt: new Date() });
  const count = await OutboxReport.count();
  if (count > 2_880) {
    const oldest = await OutboxReport.findAll({ order: [["createdAt", "ASC"]], limit: count - 2_880 });
    await OutboxReport.destroy({ where: { id: oldest.map((row) => row.id) } });
  }
};

/** Reads a bounded oldest-first batch so retries preserve event order. */
export const readOutboxBatch = async () => OutboxReport.findAll({ order: [["createdAt", "ASC"]], limit: 100 });
