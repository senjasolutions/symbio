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
  {
    version: 6,
    name: "allow admin role in users table",
    up: async (transaction) => {
      // SQLite cannot drop constraints, so recreate the users table with the
      // corrected CHECK constraint that allows both 'superadmin' and 'admin'.
      const countBefore = (await sequelize.query("SELECT COUNT(*) AS cnt FROM users", { type: QueryTypes.SELECT, transaction }))[0].cnt;
      await sequelize.query(
        `CREATE TABLE users_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'superadmin' CHECK (role IN ('superadmin', 'admin')),
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        )`, { transaction },
      );
      await sequelize.query(
        "INSERT INTO users_v2 (id, username, display_name, email, password_hash, role, created_at, updated_at) SELECT id, username, display_name, email, password_hash, role, created_at, updated_at FROM users",
        { transaction },
      );
      const countAfter = (await sequelize.query("SELECT COUNT(*) AS cnt FROM users_v2", { type: QueryTypes.SELECT, transaction }))[0].cnt;
      if (countBefore !== countAfter) {
        throw new Error(`Migration v6 integrity failure: users row count changed from ${countBefore} to ${countAfter}`);
      }
      await sequelize.query("DROP TABLE users", { transaction });
      await sequelize.query("ALTER TABLE users_v2 RENAME TO users", { transaction });
    },
  },
  {
    version: 7,
    name: "add language column to users",
    up: async (transaction) => {
      await sequelize.query("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'", { transaction });
    },
  },
  {
    version: 8,
    name: "add ai_history table for LLM request/response persistence",
    up: async (transaction) => {
      await sequelize.query(`CREATE TABLE ai_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL,
        log_content TEXT,
        context TEXT,
        request_text TEXT,
        response_text TEXT,
        reasoning_content TEXT,
        response_html TEXT,
        token_input INTEGER DEFAULT 0,
        token_output INTEGER DEFAULT 0,
        token_total INTEGER DEFAULT 0,
        response_time_ms INTEGER DEFAULT 0,
        log_name TEXT,
        source_url TEXT,
        log_type TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_ai_history_created ON ai_history(created_at DESC)", { transaction });
    },
  },
  {
    version: 9,
    name: "add skill system tables for Symbio Intelligence",
    up: async (transaction) => {
      await sequelize.query(`CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT DEFAULT 'gear',
        schedule_interval TEXT DEFAULT '0 */6 * * *',
        enabled INTEGER DEFAULT 1,
        safety_tier TEXT DEFAULT 'confirm',
        config JSON,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });
      await sequelize.query(`CREATE TABLE skill_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL REFERENCES skills(id),
        trigger TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'running',
        started_at DATETIME,
        finished_at DATETIME,
        summary TEXT,
        data_collected JSON,
        llm_request_tokens INTEGER,
        llm_response_tokens INTEGER,
        llm_model TEXT,
        llm_response_time_ms INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_skill_runs_skill ON skill_runs(skill_id, started_at DESC)", { transaction });
      await sequelize.query(`CREATE TABLE skill_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_run_id INTEGER NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
        severity TEXT DEFAULT 'info',
        title TEXT NOT NULL,
        description TEXT,
        source TEXT,
        is_simple_fix INTEGER DEFAULT 0,
        suggested_fix TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_skill_findings_run ON skill_findings(skill_run_id)", { transaction });
      await sequelize.query(`CREATE TABLE skill_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_run_id INTEGER NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
        finding_id INTEGER REFERENCES skill_findings(id),
        action_type TEXT NOT NULL,
        target TEXT,
        parameters JSON,
        status TEXT DEFAULT 'pending',
        result JSON,
        approved_by TEXT,
        approved_at DATETIME,
        executed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_skill_actions_status ON skill_actions(status)", { transaction });
      await sequelize.query(`CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_run_id INTEGER REFERENCES skill_runs(id),
        action_id INTEGER REFERENCES skill_actions(id),
        severity TEXT DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT,
        link TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_notifications_unread ON notifications(is_read, created_at DESC)", { transaction });
      // Seed 4 default skill definitions
      await sequelize.query(`INSERT INTO skills (key, name, description, icon, schedule_interval, enabled, safety_tier, config, created_at, updated_at) VALUES
        ('package-updater', 'Package Updater', 'Check for available package updates, prioritize security patches, and apply them safely.', 'fa-solid fa-box', '0 */6 * * *', 1, 'confirm', '{}', datetime('now'), datetime('now')),
        ('storage-maid', 'Storage Maid', 'Monitor disk usage, identify space hogs, and perform safe cleanup.', 'fa-solid fa-hard-drive', '0 */2 * * *', 1, 'auto', '{}', datetime('now'), datetime('now')),
        ('uptime-police', 'Uptime Police', 'Monitor service health and restart frozen services automatically.', 'fa-solid fa-heart-pulse', '* * * * *', 1, 'auto', '{}', datetime('now'), datetime('now')),
        ('error-finder', 'Error Finder', 'Scan system and application logs for errors and report findings.', 'fa-solid fa-magnifying-glass', '*/10 * * * *', 1, 'confirm', '{}', datetime('now'), datetime('now'))
      `, { transaction });
    },
  },
  {
    version: 10,
    name: "add memory column to skills for LLM persistent context",
    up: async (transaction) => {
      // Add memory column — stores accumulated LLM context per skill
      try { await sequelize.query("ALTER TABLE skills ADD COLUMN memory TEXT DEFAULT ''", { transaction }); } catch {}
    },
  },
  {
    version: 11,
    name: "create token_usage table for per-call LLM billing tracking",
    up: async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          skill_id INTEGER REFERENCES skills(id),
          skill_run_id INTEGER REFERENCES skill_runs(id),
          skill_key TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'skill',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `, { transaction });
      await sequelize.query(
        "CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at)",
        { transaction }
      );
      await sequelize.query(
        "CREATE INDEX IF NOT EXISTS idx_token_usage_skill ON token_usage(skill_key)",
        { transaction }
      );
    },
  },
  {
    version: 12,
    name: "create alert system tables and add cpu_iowait metric",
    up: async (transaction) => {
      // Add CPU I/O wait percentage column to existing metric samples table
      try { await sequelize.query("ALTER TABLE server_statuses ADD COLUMN cpu_iowait_percent REAL", { transaction }); } catch {}

      // User-defined alert threshold rules
      await sequelize.query(`CREATE TABLE alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        resource TEXT NOT NULL,
        metric_field TEXT NOT NULL,
        operator TEXT NOT NULL DEFAULT 'gt',
        threshold_value REAL NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 120,
        cooldown_seconds INTEGER NOT NULL DEFAULT 600,
        severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_channels TEXT DEFAULT '[]',
        diagnostic_enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });

      // Alert firing history — one row per trigger/resolution cycle
      await sequelize.query(`CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        triggered_at DATETIME NOT NULL,
        resolved_at DATETIME,
        metric_value REAL NOT NULL,
        threshold_value REAL NOT NULL,
        diagnostic_json TEXT,
        status TEXT NOT NULL DEFAULT 'firing' CHECK (status IN ('firing', 'resolved', 'acknowledged')),
        acknowledged_by INTEGER REFERENCES users(id),
        acknowledged_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`, { transaction });
      await sequelize.query("CREATE INDEX idx_alert_events_status ON alert_events(status, triggered_at DESC)", { transaction });
      await sequelize.query("CREATE INDEX idx_alert_events_rule ON alert_events(rule_id, triggered_at DESC)", { transaction });

      // Modular notification channel registry for Slack, Discord, email, etc.
      await sequelize.query(`CREATE TABLE notification_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT 'slack',
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )`, { transaction });

      // Seed default alert rules for immediate coverage
      const now = new Date().toISOString();
      const server = (await sequelize.query("SELECT id FROM servers WHERE slug = 'main-server'", { type: QueryTypes.SELECT, transaction }))[0];
      if (server) {
        const defaultRules = [
          ["High CPU Usage", "cpu", "cpuPercent", 90, 120, 600, "warning"],
          ["High Memory Usage", "memory", "memoryPercent", 90, 120, 600, "warning"],
          ["High Swap Usage", "swap", "swapPercent", 50, 300, 900, "warning"],
          ["High Disk Usage", "disk", "diskPercent", 90, 120, 600, "critical"],
          ["High Load Average (1 min)", "load", "load1", 0, 300, 900, "warning"], // 0 = auto-calculate from cores
          ["High CPU I/O Wait", "cpu", "cpuIowaitPercent", 50, 120, 600, "warning"],
        ];
        for (const [name, resource, metricField, threshold, duration, cooldown, severity] of defaultRules) {
          await sequelize.query(
            "INSERT INTO alert_rules (server_id, name, resource, metric_field, threshold_value, duration_seconds, cooldown_seconds, severity, enabled, notify_channels, diagnostic_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', 1, ?, ?)",
            { replacements: [server.id, name, resource, metricField, threshold, duration, cooldown, severity, now, now], transaction },
          );
        }
      }
    },
  },
  {
    version: 13,
    name: "extend alert_rules for application and service targets [no-op — collided with theme migration, real work in v15]",
    up: async () => {},
  },
  {
    version: 14,
    name: "add theme setting for UI color scheme (blue/red/green)",
    /** Inserts the server-wide theme setting so the Soft Neumorphism UI can use
     *  the selected color scheme. Defaults to 'blue'. The <html> element gets a
     *  .theme-{value} class that overrides CSS accent custom properties. */
    up: async (transaction) => {
      await sequelize.query(
        "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('theme', 'blue', ?)",
        { replacements: [new Date().toISOString()], transaction },
      );
    },
  },
  {
    version: 15,
    name: "add target_id and status_match columns to alert_rules",
    /** Adds columns needed for application/service alert rules. */
    up: async (transaction) => {
      await sequelize.query("ALTER TABLE alert_rules ADD COLUMN target_id INTEGER", { transaction });
      await sequelize.query("ALTER TABLE alert_rules ADD COLUMN status_match TEXT DEFAULT '[]'", { transaction });
    },
  },
  {
    version: 16,
    name: "add network throughput columns to server_statuses",
    /** Tracks aggregate network throughput (bytes/sec) from /proc/net/dev deltas.
     *  Used by the alert system for network throughput threshold rules. */
    up: async (transaction) => {
      await sequelize.query("ALTER TABLE server_statuses ADD COLUMN network_rx_bytes_per_sec REAL", { transaction });
      await sequelize.query("ALTER TABLE server_statuses ADD COLUMN network_tx_bytes_per_sec REAL", { transaction });
    },
  },
  {
    version: 17,
    name: "add pattern dedup columns to skill_findings for cross-run deduplication",
    /** Adds pattern (dedup key), seen_count (incrementing counter),
     *  last_seen_at (latest observation), and status (open/acknowledged/resolved)
     *  so that finding duplicates across skill runs are merged into one row
     *  instead of creating new rows every time. */
    up: async (transaction) => {
      try { await sequelize.query("ALTER TABLE skill_findings ADD COLUMN pattern TEXT DEFAULT ''", { transaction }); } catch {}
      try { await sequelize.query("ALTER TABLE skill_findings ADD COLUMN seen_count INTEGER DEFAULT 1", { transaction }); } catch {}
      try { await sequelize.query("ALTER TABLE skill_findings ADD COLUMN last_seen_at DATETIME", { transaction }); } catch {}
      try { await sequelize.query("ALTER TABLE skill_findings ADD COLUMN status TEXT DEFAULT 'open'", { transaction }); } catch {}
      await sequelize.query("CREATE INDEX IF NOT EXISTS idx_skill_findings_pattern ON skill_findings(pattern, status)", { transaction });
    },
  },
  {
    version: 18,
    name: "add indexes on skill_actions FK columns for JOIN performance",
    up: async (transaction) => {
      await sequelize.query("CREATE INDEX IF NOT EXISTS idx_skill_actions_run ON skill_actions(skill_run_id)", { transaction });
      await sequelize.query("CREATE INDEX IF NOT EXISTS idx_skill_actions_finding ON skill_actions(finding_id)", { transaction });
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
