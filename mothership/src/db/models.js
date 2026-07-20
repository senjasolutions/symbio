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
    cpuIowaitPercent: { type: DataTypes.FLOAT, field: "cpu_iowait_percent" },
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
    networkRxBytesPerSec: { type: DataTypes.FLOAT, field: "network_rx_bytes_per_sec" },
    networkTxBytesPerSec: { type: DataTypes.FLOAT, field: "network_tx_bytes_per_sec" },
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

  const AIHistory = sequelize.define("AIHistory", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    provider: { type: DataTypes.STRING, allowNull: false },
    model: { type: DataTypes.STRING, defaultValue: "" },
    question: { type: DataTypes.TEXT, allowNull: false },
    logContent: { type: DataTypes.TEXT, field: "log_content" },
    context: { type: DataTypes.TEXT },
    requestText: { type: DataTypes.TEXT, field: "request_text" },
    responseText: { type: DataTypes.TEXT, field: "response_text" },
    reasoningContent: { type: DataTypes.TEXT, field: "reasoning_content" },
    responseHtml: { type: DataTypes.TEXT, field: "response_html" },
    tokenInput: { type: DataTypes.INTEGER, field: "token_input", defaultValue: 0 },
    tokenOutput: { type: DataTypes.INTEGER, field: "token_output", defaultValue: 0 },
    tokenTotal: { type: DataTypes.INTEGER, field: "token_total", defaultValue: 0 },
    responseTimeMs: { type: DataTypes.INTEGER, field: "response_time_ms", defaultValue: 0 },
    logName: { type: DataTypes.STRING, field: "log_name" },
    sourceUrl: { type: DataTypes.TEXT, field: "source_url" },
    logType: { type: DataTypes.STRING, field: "log_type" },
    ...commonEntity,
  }, { tableName: "ai_history", timestamps: true, underscored: true });

  const Skill = sequelize.define("Skill", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: DataTypes.TEXT,
    icon: { type: DataTypes.STRING, defaultValue: "gear" },
    scheduleInterval: { type: DataTypes.STRING, defaultValue: "0 */6 * * *", field: "schedule_interval" },
    enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    safetyTier: { type: DataTypes.STRING, defaultValue: "confirm", field: "safety_tier" },
    config: { type: DataTypes.TEXT },
    memory: { type: DataTypes.TEXT, defaultValue: "" },
    ...commonEntity,
  }, { tableName: "skills", timestamps: true, underscored: true });

  const SkillRun = sequelize.define("SkillRun", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    skillId: { type: DataTypes.INTEGER, allowNull: false, field: "skill_id" },
    trigger: { type: DataTypes.STRING, defaultValue: "scheduled" },
    status: { type: DataTypes.STRING, defaultValue: "running" },
    startedAt: { type: DataTypes.DATE, field: "started_at" },
    finishedAt: { type: DataTypes.DATE, field: "finished_at" },
    summary: DataTypes.TEXT,
    dataCollected: { type: DataTypes.TEXT, field: "data_collected" },
    llmRequestTokens: { type: DataTypes.INTEGER, field: "llm_request_tokens" },
    llmResponseTokens: { type: DataTypes.INTEGER, field: "llm_response_tokens" },
    llmModel: { type: DataTypes.STRING, field: "llm_model" },
    llmResponseTimeMs: { type: DataTypes.INTEGER, field: "llm_response_time_ms" },
    errorMessage: { type: DataTypes.TEXT, field: "error_message" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "skill_runs", timestamps: false });

  const SkillFinding = sequelize.define("SkillFinding", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    skillRunId: { type: DataTypes.INTEGER, allowNull: false, field: "skill_run_id" },
    severity: { type: DataTypes.STRING, defaultValue: "info" },
    title: { type: DataTypes.STRING, allowNull: false },
    description: DataTypes.TEXT,
    source: DataTypes.STRING,
    isSimpleFix: { type: DataTypes.BOOLEAN, defaultValue: false, field: "is_simple_fix" },
    suggestedFix: { type: DataTypes.TEXT, field: "suggested_fix" },
    /** Cross-run dedup: pattern from LLM, seen count, last observation, status */
    pattern: { type: DataTypes.TEXT, defaultValue: "" },
    seenCount: { type: DataTypes.INTEGER, defaultValue: 1, field: "seen_count" },
    lastSeenAt: { type: DataTypes.DATE, field: "last_seen_at" },
    status: { type: DataTypes.STRING, defaultValue: "open" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "skill_findings", timestamps: false });

  const SkillAction = sequelize.define("SkillAction", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    skillRunId: { type: DataTypes.INTEGER, allowNull: false, field: "skill_run_id" },
    findingId: { type: DataTypes.INTEGER, field: "finding_id" },
    actionType: { type: DataTypes.STRING, allowNull: false, field: "action_type" },
    target: DataTypes.STRING,
    parameters: { type: DataTypes.TEXT },
    status: { type: DataTypes.STRING, defaultValue: "pending" },
    result: { type: DataTypes.TEXT },
    approvedBy: { type: DataTypes.STRING, field: "approved_by" },
    approvedAt: { type: DataTypes.DATE, field: "approved_at" },
    executedAt: { type: DataTypes.DATE, field: "executed_at" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "skill_actions", timestamps: false });

  const Notification = sequelize.define("Notification", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    skillRunId: { type: DataTypes.INTEGER, field: "skill_run_id" },
    actionId: { type: DataTypes.INTEGER, field: "action_id" },
    severity: { type: DataTypes.STRING, defaultValue: "info" },
    title: { type: DataTypes.STRING, allowNull: false },
    message: DataTypes.TEXT,
    link: DataTypes.TEXT,
    isRead: { type: DataTypes.BOOLEAN, defaultValue: false, field: "is_read" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "notifications", timestamps: false });

  const TokenUsage = sequelize.define("TokenUsage", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    skillId: { type: DataTypes.INTEGER, field: "skill_id" },
    skillRunId: { type: DataTypes.INTEGER, field: "skill_run_id" },
    skillKey: { type: DataTypes.STRING, defaultValue: "", field: "skill_key" },
    model: { type: DataTypes.STRING, defaultValue: "" },
    promptTokens: { type: DataTypes.INTEGER, defaultValue: 0, field: "prompt_tokens" },
    completionTokens: { type: DataTypes.INTEGER, defaultValue: 0, field: "completion_tokens" },
    totalTokens: { type: DataTypes.INTEGER, defaultValue: 0, field: "total_tokens" },
    source: { type: DataTypes.STRING, defaultValue: "skill" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "token_usage", timestamps: false });

  // Alert system: user-defined threshold rules per resource metric
  const AlertRule = sequelize.define("AlertRule", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    name: { type: DataTypes.STRING, allowNull: false },
    resource: { type: DataTypes.STRING, allowNull: false },
    metricField: { type: DataTypes.STRING, allowNull: false, field: "metric_field" },
    operator: { type: DataTypes.STRING, allowNull: false, defaultValue: "gt" },
    thresholdValue: { type: DataTypes.FLOAT, allowNull: false, field: "threshold_value" },
    durationSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 120, field: "duration_seconds" },
    cooldownSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 600, field: "cooldown_seconds" },
    severity: { type: DataTypes.STRING, allowNull: false, defaultValue: "warning" },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyChannels: { type: DataTypes.TEXT, defaultValue: "[]", field: "notify_channels" },
    diagnosticEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: "diagnostic_enabled" },
    targetId: { type: DataTypes.INTEGER, field: "target_id" },
    statusMatch: { type: DataTypes.TEXT, defaultValue: "[]", field: "status_match" },
    healSkillKey: { type: DataTypes.TEXT, field: "heal_skill_key" },
    ...commonEntity,
  }, { tableName: "alert_rules", timestamps: true, underscored: true });

  // Record of each alert trigger/resolution cycle
  const AlertEvent = sequelize.define("AlertEvent", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ruleId: { type: DataTypes.INTEGER, allowNull: false, field: "rule_id" },
    serverId: { type: DataTypes.INTEGER, allowNull: false, field: "server_id" },
    triggeredAt: { type: DataTypes.DATE, allowNull: false, field: "triggered_at" },
    resolvedAt: { type: DataTypes.DATE, field: "resolved_at" },
    metricValue: { type: DataTypes.FLOAT, allowNull: false, field: "metric_value" },
    thresholdValue: { type: DataTypes.FLOAT, allowNull: false, field: "threshold_value" },
    diagnosticJson: { type: DataTypes.TEXT, field: "diagnostic_json" },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: "firing" },
    acknowledgedBy: { type: DataTypes.INTEGER, field: "acknowledged_by" },
    acknowledgedAt: { type: DataTypes.DATE, field: "acknowledged_at" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
  }, { tableName: "alert_events", timestamps: false });

  // Modular notification channel registry
  const NotificationChannel = sequelize.define("NotificationChannel", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: "slack" },
    name: { type: DataTypes.STRING, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    config: { type: DataTypes.TEXT, allowNull: false, defaultValue: "{}" },
    ...commonEntity,
  }, { tableName: "notification_channels", timestamps: true, underscored: true });

  // Execution request — modular confirmation layer before command execution.
  // Stores AI-generated explanation, commands, risk assessment, and revision chat history.
  const ExecutionRequest = sequelize.define("ExecutionRequest", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    displayId: { type: DataTypes.STRING, allowNull: false, unique: true, field: "display_id" },
    actionId: { type: DataTypes.INTEGER, allowNull: false, field: "action_id" },
    actionType: { type: DataTypes.STRING, defaultValue: "", field: "action_type" },
    commands: { type: DataTypes.TEXT, defaultValue: "[]" },
    explanation: { type: DataTypes.TEXT, defaultValue: "" },
    riskLevel: { type: DataTypes.STRING, defaultValue: "low", field: "risk_level" },
    affected: { type: DataTypes.TEXT, defaultValue: "" },
    revisionHistory: { type: DataTypes.TEXT, defaultValue: "[]", field: "revision_history" },
    status: { type: DataTypes.STRING, defaultValue: "pending" },
    createdAt: { type: DataTypes.DATE, field: "created_at", defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, field: "updated_at", defaultValue: DataTypes.NOW },
  }, { tableName: "execution_requests", timestamps: true, underscored: true });

  // Associations for cross-model queries (used by upsertFinding dedup)
  SkillFinding.belongsTo(SkillRun, { foreignKey: "skill_run_id", as: "skillRun" });
  SkillRun.hasMany(SkillFinding, { foreignKey: "skill_run_id", as: "skillFindings" });
  // ExecutionRequest → SkillAction (for JOIN queries and detail lookups)
  ExecutionRequest.belongsTo(SkillAction, { foreignKey: "action_id", as: "action" });

  return {
    User, Session, Server, Agent, AgentReport, ServerStatus, ServerService,
    ServerServiceStatus, Application, ApplicationStatus, ApplicationLog, ApplicationTag,
    ApplicationTagAssignment, ApplicationSource, Setting, AIHistory,
    Skill, SkillRun, SkillFinding, SkillAction, Notification, TokenUsage,
    AlertRule, AlertEvent, NotificationChannel, ExecutionRequest,
  };
};
