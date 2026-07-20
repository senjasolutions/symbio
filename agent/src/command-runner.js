/**
 * Command Runner — formal command registry for ALL host command execution.
 *
 * Every command executed on the host goes through this module:
 * 1. Registry lookup (command must be registered)
 * 2. Parameter validation (format checks, whitelists)
 * 3. execFile() execution (never shell, never exec())
 * 4. Audit logging (every call recorded to command_audit_log table)
 *
 * This is the ONLY code path for host write operations.
 * Skills-executor.js delegates here for backward compatibility.
 */

import { execFile } from "node:child_process";
import { sequelize } from "./db.js";

// ── Shared Validators ──────────────────────────────────────────────

const SERVICE_WHITELIST = new Set([
  "nginx", "apache2", "httpd", "mysql", "mysqld", "mariadb",
  "postgresql", "postgresql@*", "redis-server", "redis",
  "docker", "containerd", "pm2", "ssh", "sshd",
]);

const SAFE_LOG_DIRS = [
  "/var/log", "/var/log/nginx", "/var/log/apache2", "/var/log/mysql",
  "/var/log/postgresql", "/var/log/redis", "/var/log/docker",
];

const PACKAGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9\-\.\+:]*$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9\/.:_-]*$/;
const SYSCTL_CMD_RE = /^sysctl -w [a-zA-Z0-9._-]+=/;

const validatePackageName = (pkg) => {
  if (!PACKAGE_NAME_RE.test(pkg)) throw new Error(`Invalid package name: ${pkg}`);
};

const validateServiceName = (name) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\_\.\@\*]*$/.test(name)) throw new Error(`Invalid service name: ${name}`);
};

const validateFilePath = (path, allowedPrefixes) => {
  if (path.includes("..") || path.includes("\0")) throw new Error("Invalid path (contains .. or null byte)");
  const resolved = path.startsWith("/") ? path : `/${path}`;
  if (!allowedPrefixes.some((prefix) => resolved.startsWith(prefix))) throw new Error(`Path not in allowed directories: ${path}`);
};

const validateContainerName = (name) => {
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`Invalid container name: ${name}`);
};

const validateImageName = (name) => {
  if (!IMAGE_NAME_RE.test(name)) throw new Error(`Invalid image name: ${name}`);
};

// ── Execution Wrapper ──────────────────────────────────────────────

const run = (cmd, args, timeout = 30000) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
    resolve({
      status: error ? "failed" : "success",
      stdout: (stdout || "").slice(0, 10000),
      stderr: (stderr || "").slice(0, 1000),
      exitCode: error?.code || 0,
    });
  });
  child.on("error", (err) => resolve({ status: "failed", stdout: "", stderr: err.message, exitCode: -1 }));
});

// ── Audit Log ──────────────────────────────────────────────────────

/**
 * Writes a structured audit entry to the command_audit_log table.
 * Non-blocking — failures are caught silently.
 */
const writeAuditLog = async (entry) => {
  try {
    await sequelize.query(`INSERT INTO command_audit_log
      (action_type, parameters, command, stdout_snippet, stderr_snippet,
       exit_code, status, execution_time_ms, triggered_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, {
      replacements: [
        entry.actionType || "",
        entry.parameters || "{}",
        entry.command || "",
        (entry.stdout || "").slice(0, 500),
        (entry.stderr || "").slice(0, 500),
        entry.exitCode ?? 0,
        entry.status || "success",
        entry.executionTimeMs || 0,
        entry.triggeredBy || "skill",
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    // Audit logging should never fail the main operation
    console.error("Audit log write failed (non-fatal):", err.message);
  }
};

// ── Registry Helpers ───────────────────────────────────────────────

/**
 * Creates a standard execute function for simple single-command handlers.
 * @param {string} cmd - The executable
 * @param {string[]} baseArgs - Static arguments
 * @param {number} defaultTimeout - Default timeout in ms
 * @param {function} [buildParamsArgs] - Optional: extra args from params
 */
const simpleExec = (cmd, baseArgs, defaultTimeout, buildParamsArgs) => {
  return async (params, timeout) => {
    const args = buildParamsArgs ? [...baseArgs, ...buildParamsArgs(params)] : baseArgs;
    return run(cmd, args, timeout || defaultTimeout);
  };
};

// ── Command Registry ───────────────────────────────────────────────

/**
 * COMMAND_REGISTRY — every entry is a whitelisted command.
 *
 * Each entry:
 *   tier: 1 = auto-safe (no approval needed), 2 = requires Execution Request
 *   risk: human-readable risk level
 *   validateParams(params): throws on invalid params
 *   execute(params, timeout): returns Promise<{status, stdout, stderr, exitCode}>
 */
const COMMAND_REGISTRY = {};

// ── Package Management ─────────────────────────────────────────────

COMMAND_REGISTRY["apt.update"] = {
  tier: 1,
  risk: "low",
  description: "Update package index from repositories",
  affected: "Package manager, APT cache",
  timeout: 120000,
  validateParams: () => {},
  execute: simpleExec("apt-get", ["update"], 120000),
};

COMMAND_REGISTRY["apt.list-upgradable"] = {
  tier: 1,
  risk: "low",
  description: "List available package updates",
  affected: "None — read-only",
  timeout: 60000,
  validateParams: () => {},
  execute: simpleExec("apt", ["list", "--upgradable"], 60000),
};

COMMAND_REGISTRY["apt.upgrade-dry-run"] = {
  tier: 1,
  risk: "low",
  description: "Simulate package upgrade (no changes)",
  affected: "None — simulation only",
  timeout: 120000,
  validateParams: (params) => {
    if (params.packages?.length) params.packages.forEach(validatePackageName);
  },
  execute: simpleExec("apt-get", ["upgrade", "--dry-run"], 120000, (params) => params.packages || []),
};

COMMAND_REGISTRY["apt.upgrade"] = {
  tier: 2,
  risk: "medium",
  description: "Upgrade specified packages to latest versions",
  affected: "Installed packages, system services",
  timeout: 300000,
  validateParams: (params) => {
    if (!params.packages?.length) throw new Error("No packages specified");
    params.packages.forEach(validatePackageName);
  },
  execute: simpleExec("apt-get", ["upgrade", "-y", "--only-upgrade"], 300000, (params) => params.packages || []),
};

COMMAND_REGISTRY["apt.autoremove"] = {
  tier: 1,
  risk: "low",
  description: "Remove automatically installed packages no longer needed",
  affected: "Installed packages",
  timeout: 120000,
  validateParams: () => {},
  execute: simpleExec("apt-get", ["autoremove", "-y"], 120000),
};

COMMAND_REGISTRY["apt.clean"] = {
  tier: 1,
  risk: "low",
  description: "Clear APT package cache to free disk space",
  affected: "Disk space, APT cache",
  timeout: 60000,
  validateParams: () => {},
  execute: simpleExec("apt-get", ["clean"], 60000),
};

// ── Process Management ─────────────────────────────────────────────

const validatePid = (pid) => {
  if (typeof pid !== "number" && typeof pid !== "string") throw new Error("PID must be a number.");
  const num = Number(pid);
  if (!Number.isInteger(num) || num < 1) throw new Error("Invalid PID.");
  return num;
};

COMMAND_REGISTRY["process.kill"] = {
  tier: 2,
  risk: "medium",
  description: "Send SIGTERM to a process (graceful termination)",
  affected: "Target process and its child processes",
  timeout: 15000,
  validateParams: (params) => { validatePid(params.pid); },
  execute: simpleExec("kill", ["-TERM"], 15000, (params) => [String(params.pid)]),
};

COMMAND_REGISTRY["process.kill-force"] = {
  tier: 2,
  risk: "high",
  description: "Send SIGKILL to a process (forced immediate termination)",
  affected: "Target process and its child processes",
  timeout: 15000,
  validateParams: (params) => { validatePid(params.pid); },
  execute: simpleExec("kill", ["-KILL"], 15000, (params) => [String(params.pid)]),
};

// ── Package Queries ────────────────────────────────────────────────

COMMAND_REGISTRY["dpkg.list"] = {
  tier: 1,
  risk: "low",
  description: "List all installed packages with versions",
  affected: "None — read-only",
  timeout: 60000,
  validateParams: () => {},
  execute: simpleExec("dpkg-query", ["-W", "-f", "${Package} ${Version} ${Status}\n"], 60000),
};

// ── Service Management ─────────────────────────────────────────────

COMMAND_REGISTRY["systemctl.status"] = {
  tier: 1,
  risk: "low",
  description: "Check systemd service status",
  affected: "None — read-only",
  timeout: 15000,
  validateParams: (params) => { validateServiceName(params.service); },
  execute: simpleExec("systemctl", [], 15000, (params) => ["status", params.service]),
};

COMMAND_REGISTRY["systemctl.is-active"] = {
  tier: 1,
  risk: "low",
  description: "Check if a systemd service is active",
  affected: "None — read-only",
  timeout: 15000,
  validateParams: (params) => { validateServiceName(params.service); },
  execute: simpleExec("systemctl", [], 15000, (params) => ["is-active", params.service]),
};

COMMAND_REGISTRY["systemctl.restart"] = {
  tier: 2,
  risk: "medium",
  description: "Restart a systemd service",
  affected: "Target service (brief downtime)",
  timeout: 30000,
  validateParams: (params) => {
    validateServiceName(params.service);
    if (!SERVICE_WHITELIST.has(params.service)) throw new Error(`Service not whitelisted: ${params.service}`);
  },
  execute: simpleExec("systemctl", [], 30000, (params) => ["restart", params.service]),
};

COMMAND_REGISTRY["systemctl.start"] = {
  tier: 1,
  risk: "low",
  description: "Start a systemd service",
  affected: "Target service",
  timeout: 30000,
  validateParams: (params) => { validateServiceName(params.service); },
  execute: simpleExec("systemctl", [], 30000, (params) => ["start", params.service]),
};

COMMAND_REGISTRY["systemctl.stop"] = {
  tier: 2,
  risk: "medium",
  description: "Stop a systemd service",
  affected: "Target service (downtime until restarted)",
  timeout: 30000,
  validateParams: (params) => { validateServiceName(params.service); },
  execute: simpleExec("systemctl", [], 30000, (params) => ["stop", params.service]),
};

COMMAND_REGISTRY["systemctl.reload"] = {
  tier: 1,
  risk: "low",
  description: "Reload a systemd service configuration without full restart",
  affected: "Target service",
  timeout: 30000,
  validateParams: (params) => { validateServiceName(params.service); },
  execute: simpleExec("systemctl", [], 30000, (params) => ["reload", params.service]),
};

// ── System Logs ────────────────────────────────────────────────────

COMMAND_REGISTRY["journalctl.vacuum"] = {
  tier: 1,
  risk: "low",
  description: "Remove old journal log entries, keep recent only",
  affected: "System logs, Disk space",
  timeout: 60000,
  validateParams: () => {},
  execute: simpleExec("journalctl", ["--vacuum-time=7d"], 60000),
};

// ── File Operations ────────────────────────────────────────────────

COMMAND_REGISTRY["file.truncate"] = {
  tier: 1,
  risk: "low",
  description: "Empty a log file (preserves file, deletes contents)",
  affected: "Targeted log file",
  timeout: 15000,
  validateParams: (params) => { validateFilePath(params.target, SAFE_LOG_DIRS); },
  execute: simpleExec("truncate", ["-s", "0"], 15000, (params) => [params.target]),
};

COMMAND_REGISTRY["file.remove"] = {
  tier: 2,
  risk: "low",
  description: "Permanently delete a file",
  affected: "File system",
  timeout: 15000,
  validateParams: (params) => { validateFilePath(params.target, ["/tmp", "/var/cache/apt"]); },
  execute: simpleExec("rm", ["-f"], 15000, (params) => [params.target]),
};

COMMAND_REGISTRY["file.find-large"] = {
  tier: 1,
  risk: "low",
  description: "Find large files in specified directories",
  affected: "None — read-only",
  timeout: 60000,
  validateParams: (params) => {
    (params.dirs || ["/var/log"]).forEach((d) => validateFilePath(d, ["/var/log", "/var/cache", "/tmp", "/var/lib/docker"]));
  },
  execute: simpleExec("find", [], 60000,
    (params) => [...(params.dirs || ["/var/log"]), "-type", "f", "-size", `+${params.minMb || 50}M`, "-printf", "%s %p\\n"]),
};

COMMAND_REGISTRY["du.directory"] = {
  tier: 1,
  risk: "low",
  description: "Show disk usage of a directory",
  affected: "None — read-only",
  timeout: 30000,
  validateParams: (params) => {
    validateFilePath(params.dir, ["/var/log", "/var/cache", "/tmp", "/var/lib/docker", "/var/lib/postgresql"]);
  },
  execute: simpleExec("du", ["-sh"], 30000, (params) => [params.dir]),
};

COMMAND_REGISTRY["df.summary"] = {
  tier: 1,
  risk: "low",
  description: "Show disk usage summary for all filesystems",
  affected: "None — read-only",
  timeout: 15000,
  validateParams: () => {},
  execute: simpleExec("df", ["-h"], 15000),
};

// ── Configuration Changes ──────────────────────────────────────────
// Was missing from skills-executor.js — makes Optimizer actionable.

COMMAND_REGISTRY["config.change"] = {
  tier: 2,
  risk: "medium",
  description: "Apply system configuration changes",
  affected: "System configuration (sysctl, kernel parameters)",
  timeout: 30000,
  validateParams: (params) => {
    const cmds = Array.isArray(params.commands) ? params.commands : [];
    if (!cmds.length) throw new Error("No configuration commands specified");
    for (const cmd of cmds) {
      if (typeof cmd !== "string") throw new Error("Each command must be a string");
      // For now, only allow sysctl commands. Expand as needed.
      if (!SYSCTL_CMD_RE.test(cmd)) throw new Error(`Unsupported config command. Only sysctl -w is allowed: ${cmd}`);
    }
  },
  execute: async (params, timeout) => {
    const cmds = Array.isArray(params.commands) ? params.commands : [];
    const results = [];
    for (const cmdStr of cmds) {
      const parts = cmdStr.split(/\s+/);
      const result = await run(parts[0], parts.slice(1), timeout || 30000);
      results.push(result);
      // Stop on first failure
      if (result.status === "failed") {
        return { status: "failed", stdout: result.stdout, stderr: `Command failed: ${cmdStr}\n${result.stderr}`, exitCode: result.exitCode };
      }
    }
    return { status: "success", stdout: results.map((r, i) => `[${i + 1}/${cmds.length}] ${r.stdout}`).join("\n"), stderr: "", exitCode: 0 };
  },
};

// ── Docker Management ──────────────────────────────────────────────
// Phase 2: Docker socket must be read-write for these to work.

COMMAND_REGISTRY["docker.restart"] = {
  tier: 2,
  risk: "medium",
  description: "Restart a Docker container",
  affected: "Docker container (brief downtime)",
  timeout: 30000,
  validateParams: (params) => { validateContainerName(params.container); },
  execute: simpleExec("docker", ["restart"], 30000, (params) => [params.container]),
};

COMMAND_REGISTRY["docker.stop"] = {
  tier: 2,
  risk: "medium",
  description: "Stop a running Docker container",
  affected: "Docker container (stopped until restarted)",
  timeout: 30000,
  validateParams: (params) => { validateContainerName(params.container); },
  execute: simpleExec("docker", ["stop"], 30000, (params) => [params.container || params.target]),
};

COMMAND_REGISTRY["docker.start"] = {
  tier: 1,
  risk: "low",
  description: "Start a stopped Docker container",
  affected: "Docker container",
  timeout: 30000,
  validateParams: (params) => { validateContainerName(params.container); },
  execute: simpleExec("docker", ["start"], 30000, (params) => [params.container || params.target]),
};

COMMAND_REGISTRY["docker.remove"] = {
  tier: 2,
  risk: "high",
  description: "Remove a stopped Docker container permanently",
  affected: "Docker container (data in container lost)",
  timeout: 30000,
  validateParams: (params) => { validateContainerName(params.container); },
  execute: simpleExec("docker", ["rm"], 30000, (params) => [params.container || params.target]),
};

COMMAND_REGISTRY["docker.remove-volume"] = {
  tier: 2,
  risk: "high",
  description: "Remove a Docker volume permanently (all data lost)",
  affected: "Docker volume storage (permanent data loss)",
  timeout: 30000,
  validateParams: (params) => { validateContainerName(params.volume); },
  execute: simpleExec("docker", ["volume", "rm"], 30000, (params) => [params.volume || params.target]),
};

COMMAND_REGISTRY["docker.prune"] = {
  tier: 1,
  risk: "low",
  description: "Remove unused Docker objects (containers, images, networks, build cache)",
  affected: "Docker storage, unused resources",
  timeout: 120000,
  validateParams: () => {},
  execute: simpleExec("docker", ["system", "prune", "-f"], 120000),
};

COMMAND_REGISTRY["docker.prune-images"] = {
  tier: 1,
  risk: "low",
  description: "Remove unused Docker images",
  affected: "Docker image storage",
  timeout: 120000,
  validateParams: () => {},
  execute: simpleExec("docker", ["image", "prune", "-f"], 120000),
};

COMMAND_REGISTRY["docker.prune-volumes"] = {
  tier: 2,
  risk: "medium",
  description: "Remove unused Docker volumes",
  affected: "Docker volume storage (data loss if used by stopped containers)",
  timeout: 120000,
  validateParams: () => {},
  execute: simpleExec("docker", ["volume", "prune", "-f"], 120000),
};

COMMAND_REGISTRY["docker.pull"] = {
  tier: 2,
  risk: "low",
  description: "Pull the latest version of a Docker image",
  affected: "Docker image storage",
  timeout: 300000,
  validateParams: (params) => { validateImageName(params.image); },
  execute: simpleExec("docker", ["pull"], 300000, (params) => [params.image]),
};

// ── PM2 Process Manager ────────────────────────────────────────────

const validatePM2Name = (name) => {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9\-_\.\@]*$/.test(name))
    throw new Error(`Invalid PM2 process name: ${name}`);
};

COMMAND_REGISTRY["pm2.start"] = {
  tier: 1,
  risk: "low",
  description: "Start a PM2-managed process",
  affected: "PM2 process",
  timeout: 30000,
  validateParams: (params) => { validatePM2Name(params.name); },
  execute: simpleExec("pm2", ["start"], 30000, (params) => [params.name]),
};

COMMAND_REGISTRY["pm2.stop"] = {
  tier: 2,
  risk: "medium",
  description: "Stop a PM2-managed process",
  affected: "PM2 process (stopped until restarted)",
  timeout: 30000,
  validateParams: (params) => { validatePM2Name(params.name); },
  execute: simpleExec("pm2", ["stop"], 30000, (params) => [params.name]),
};

COMMAND_REGISTRY["pm2.restart"] = {
  tier: 1,
  risk: "low",
  description: "Restart a PM2-managed process",
  affected: "PM2 process (brief downtime)",
  timeout: 30000,
  validateParams: (params) => { validatePM2Name(params.name); },
  execute: simpleExec("pm2", ["restart"], 30000, (params) => [params.name]),
};

COMMAND_REGISTRY["pm2.delete"] = {
  tier: 2,
  risk: "medium",
  description: "Remove a PM2-managed process from the process list",
  affected: "PM2 process (removed from PM2 management)",
  timeout: 30000,
  validateParams: (params) => { validatePM2Name(params.name); },
  execute: simpleExec("pm2", ["delete"], 30000, (params) => [params.name]),
};

// ── Nginx / Apache Config Validation ───────────────────────────────

COMMAND_REGISTRY["nginx.validate-config"] = {
  tier: 1,
  risk: "low",
  description: "Test Nginx configuration syntax for errors",
  affected: "None — validation only, no changes applied",
  timeout: 15000,
  validateParams: () => {},
  execute: simpleExec("nginx", ["-t"], 15000),
};

COMMAND_REGISTRY["apache.validate-config"] = {
  tier: 1,
  risk: "low",
  description: "Test Apache configuration syntax for errors",
  affected: "None — validation only, no changes applied",
  timeout: 15000,
  validateParams: () => {},
  execute: simpleExec("apachectl", ["-t"], 15000),
};

// ── Single Executable Entry Point ──────────────────────────────────

/**
 * Validates and runs a registered command, writing an audit log entry.
 *
 * @param {string} actionType - The registered command identifier
 * @param {object} [params={}] - Parameters for the command
 * @param {object} [context={}] - Execution context metadata
 * @param {string} [context.triggeredBy] - Who/what triggered this (default "skill")
 * @param {number} [context.executionRequestId] - Mothership execution request ID if known
 * @returns {Promise<{status: string, stdout: string, stderr: string, exitCode: number, durationMs: number}>}
 */
export async function runCommand(actionType, params = {}, context = {}) {
  const registry = COMMAND_REGISTRY[actionType];
  if (!registry) throw new Error(`Unknown command action type: ${actionType}`);

  registry.validateParams(params);

  const start = Date.now();
  let result;
  try {
    result = await registry.execute(params, registry.timeout);
  } catch (err) {
    result = { status: "failed", stdout: "", stderr: err.message, exitCode: -1 };
  }
  const durationMs = Date.now() - start;

  const execution = {
    ...result,
    durationMs,
  };

  // Build diagnostic command string for the audit log
  const execArgs = registry.sampleArgs ? registry.sampleArgs : [];
  const cmdStr = `${actionType} (${registry.description})`;

  writeAuditLog({
    actionType,
    parameters: JSON.stringify(params),
    command: cmdStr,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
    status: result.status || "failed",
    executionTimeMs: durationMs,
    triggeredBy: context.triggeredBy || "skill",
  });

  return execution;
}

// ── Backward-Compatible Handlers ───────────────────────────────────

/**
 * Builds the ACTION_HANDLERS object expected by skills-executor.js and app.js.
 * Each handler wraps runCommand() so every skill execution path goes through
 * the same validation and audit logging.
 */
export function buildActionHandlers() {
  const handlers = {};
  for (const [type, entry] of Object.entries(COMMAND_REGISTRY)) {
    handlers[type] = {
      tier: entry.tier,
      execute: async (params) => runCommand(type, params || {}),
    };
  }
  return handlers;
}
