/**
 * Sequelize models map the explicit migration schema without creating or
 * altering tables; schema changes are always handled by migrations.
 */

import { DataTypes } from "sequelize";

/** Defines all Phase 1 mothership models on one Sequelize connection. */
export const defineModels = (sequelize) => {
  const commonEntity = {
    createdAt: { type: DataTypes.DATE, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, field: "updated_at" },
  };

  const User = sequelize.define("User", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    username: { type: DataTypes.STRING, allowNull: false },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    email: { type: DataTypes.STRING, allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false, field: "password_hash" },
    role: { type: DataTypes.STRING, allowNull: false, defaultValue: "superadmin" },
    language: { type: DataTypes.STRING, allowNull: false, defaultValue: "en" },
    ...commonEntity,
  }, { tableName: "users", timestamps: true, underscored: true });

  const Session = sequelize.define("Session", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: "user_id" },
    tokenHash: { type: DataTypes.STRING, allowNull: false, field: "token_hash" },
    csrfToken: { type: DataTypes.STRING, allowNull: false, field: "csrf_token" },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: "last_seen_at" },
    createdAt: { type: DataTypes.DATE, field: "created_at" },
  }, { tableName: "sessions", timestamps: false });

  const Server = sequelize.define("Server", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    slug: { type: DataTypes.STRING, allowNull: false },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    hostname: DataTypes.STRING,
    primaryIp: { type: DataTypes.STRING, field: "primary_ip" },
    operatingSystem: { type: DataTypes.STRING, field: "operating_system" },
    kernelVersion: { type: DataTypes.STRING, field: "kernel_version" },
    hardwareJson: { type: DataTypes.TEXT, field: "hardware_json" },
    storageJson: { type: DataTypes.TEXT, field: "storage_json" },
    networkJson: { type: DataTypes.TEXT, field: "network_json" },
    ...commonEntity,
  }, { tableName: "servers", timestamps: true, underscored: true });

  const Agent = sequelize.define("Agent", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    agentKey: { type: DataTypes.STRING, allowNull: false, field: "agent_key" },
    lastSeenAt: { type: DataTypes.DATE, field: "last_seen_at" },
    lastConfigVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "last_config_version" },
    ...commonEntity,
  }, { tableName: "agents", timestamps: true, underscored: true });

  const AgentReport = sequelize.define("AgentReport", {
    id: { type: DataTypes.STRING, primaryKey: true },
    agentId: { type: DataTypes.INTEGER, allowNull: false, field: "agent_id" },
    observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
    receivedAt: { type: DataTypes.DATE, allowNull: false, field: "received_at" },
  }, { tableName: "agent_reports", timestamps: false });

  const ServerStatus = sequelize.define("ServerStatus", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    reportId: { type: DataTypes.STRING, allowNull: false, field: "report_id" },
    cpuPercent: { type: DataTypes.FLOAT, field: "cpu_percent" },
    cpuCoresJson: { type: DataTypes.TEXT, field: "cpu_cores_json" },
    memoryUsedBytes: { type: DataTypes.BIGINT, field: "memory_used_bytes" },
    memoryAvailableBytes: { type: DataTypes.BIGINT, field: "memory_available_bytes" },
    memoryTotalBytes: { type: DataTypes.BIGINT, field: "memory_total_bytes" },
    memoryPercent: { type: DataTypes.FLOAT, field: "memory_percent" },
    swapUsedBytes: { type: DataTypes.BIGINT, field: "swap_used_bytes" },
    swapTotalBytes: { type: DataTypes.BIGINT, field: "swap_total_bytes" },
    diskUsedBytes: { type: DataTypes.BIGINT, field: "disk_used_bytes" },
    diskTotalBytes: { type: DataTypes.BIGINT, field: "disk_total_bytes" },
    diskPercent: { type: DataTypes.FLOAT, field: "disk_percent" },
    load1: { type: DataTypes.FLOAT, field: "load_1" },
    load5: { type: DataTypes.FLOAT, field: "load_5" },
    load15: { type: DataTypes.FLOAT, field: "load_15" },
    uptimeSeconds: { type: DataTypes.BIGINT, field: "uptime_seconds" },
    observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
    receivedAt: { type: DataTypes.DATE, allowNull: false, field: "received_at" },
  }, { tableName: "server_statuses", timestamps: false });

  const ServerService = sequelize.define("ServerService", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    type: { type: DataTypes.STRING, allowNull: false },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    configuration: { type: DataTypes.TEXT, allowNull: false, defaultValue: "{}" },
    ...commonEntity,
  }, { tableName: "server_services", timestamps: true, underscored: true });

  const ServerServiceStatus = sequelize.define("ServerServiceStatus", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverServiceId: { type: DataTypes.INTEGER, allowNull: false, field: "server_service_id" },
    reportId: { type: DataTypes.STRING, allowNull: false, field: "report_id" },
    status: { type: DataTypes.STRING, allowNull: false },
    evidence: { type: DataTypes.STRING, allowNull: false },
    description: DataTypes.TEXT,
    responseTimeMs: { type: DataTypes.INTEGER, field: "response_time_ms" },
    observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
  }, { tableName: "server_service_statuses", timestamps: false });

  const Application = sequelize.define("Application", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    name: { type: DataTypes.STRING, allowNull: false },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    healthCheckMethod: { type: DataTypes.STRING, allowNull: false, defaultValue: "http", field: "health_check_method" },
    healthCheckUrl: { type: DataTypes.TEXT, allowNull: false, field: "health_check_url" },
    healthCheckTimeoutMs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5000, field: "health_check_timeout_ms" },
    slowThresholdMs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1500, field: "slow_threshold_ms" },
    responseTextMatch: { type: DataTypes.STRING, field: "response_text_match" },
    deletedAt: { type: DataTypes.DATE, field: "deleted_at" },
    ...commonEntity,
  }, { tableName: "applications", timestamps: true, underscored: true, paranoid: true });

  const ApplicationStatus = sequelize.define("ApplicationStatus", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    applicationId: { type: DataTypes.INTEGER, allowNull: false, field: "application_id" },
    reportId: { type: DataTypes.STRING, allowNull: false, field: "report_id" },
    status: { type: DataTypes.STRING, allowNull: false },
    statusCode: { type: DataTypes.INTEGER, field: "status_code" },
    responseTimeMs: { type: DataTypes.INTEGER, field: "response_time_ms" },
    finalUrl: { type: DataTypes.TEXT, field: "final_url" },
    failureReason: { type: DataTypes.TEXT, field: "failure_reason" },
    observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
  }, { tableName: "application_statuses", timestamps: false });

  // Registered paths belong to one application; the agent, not mothership,
  // performs the bounded host-file read after configuration synchronization.
  const ApplicationLog = sequelize.define("ApplicationLog", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    applicationId: { type: DataTypes.INTEGER, allowNull: false, field: "application_id" },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    filePath: { type: DataTypes.TEXT, allowNull: false, field: "file_path" },
    tailLines: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200, field: "tail_lines" },
    ...commonEntity,
  }, { tableName: "application_logs", timestamps: true, underscored: true });

  // Source directories registered per application serve as shortcuts into the
  // read-only file manager; the agent resolves these paths against the host root.
  const ApplicationSource = sequelize.define("ApplicationSource", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    applicationId: { type: DataTypes.INTEGER, allowNull: false, field: "application_id" },
    displayName: { type: DataTypes.STRING, allowNull: false, field: "display_name" },
    sourcePath: { type: DataTypes.TEXT, allowNull: false, field: "source_path" },
    ...commonEntity,
  }, { tableName: "application_sources", timestamps: true, underscored: true });

  const ApplicationTag = sequelize.define("ApplicationTag", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    ...commonEntity,
  }, { tableName: "application_tags", timestamps: true, underscored: true });

  const ApplicationTagAssignment = sequelize.define("ApplicationTagAssignment", {
    applicationId: { type: DataTypes.INTEGER, primaryKey: true, field: "application_id" },
    applicationTagId: { type: DataTypes.INTEGER, primaryKey: true, field: "application_tag_id" },
  }, { tableName: "application_tag_assignments", timestamps: false });

  const Setting = sequelize.define("Setting", {
    key: { type: DataTypes.STRING, primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false },
    updatedAt: { type: DataTypes.DATE, field: "updated_at" },
  }, { tableName: "settings", timestamps: false });

  return {
    User, Session, Server, Agent, AgentReport, ServerStatus, ServerService,
    ServerServiceStatus, Application, ApplicationStatus, ApplicationLog, ApplicationTag,
    ApplicationTagAssignment, ApplicationSource, Setting,
  };
};
