/**
 * Skills executor — maps whitelisted action types to hardcoded execFile() calls.
 * Each action type validates its own parameters. No shell, no arbitrary input.
 * This is the ONLY command execution path for Symbio Intelligence skills.
 */

import { execFile } from "node:child_process";

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

/** Validates a package name against the strict regex. */
const validatePackageName = (pkg) => {
  if (!PACKAGE_NAME_RE.test(pkg)) throw new Error(`Invalid package name: ${pkg}`);
};

/** Validates a systemd unit name format. */
const validateServiceName = (name) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\_\.\@\*]*$/.test(name)) throw new Error(`Invalid service name: ${name}`);
};

/** Validates a file path is within allowed directory prefixes. */
const validateFilePath = (path, allowedPrefixes) => {
  if (path.includes("..") || path.includes("\0")) throw new Error("Invalid path (contains .. or null byte)");
  const resolved = path.startsWith("/") ? path : `/${path}`;
  if (!allowedPrefixes.some((prefix) => resolved.startsWith(prefix))) throw new Error(`Path not in allowed directories: ${path}`);
};

/** Runs execFile and returns structured result. */
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

export const ACTION_HANDLERS = {
  "apt.update": {
    tier: 1,
    execute: () => run("apt-get", ["update"], 120000),
  },
  "apt.list-upgradable": {
    tier: 1,
    execute: () => run("apt", ["list", "--upgradable"], 60000),
  },
  "apt.upgrade-dry-run": {
    tier: 1,
    execute: (params) => {
      const args = ["upgrade", "--dry-run"];
      if (params.packages?.length) {
        params.packages.forEach(validatePackageName);
        args.push(...params.packages);
      }
      return run("apt-get", args, 120000);
    },
  },
  "apt.upgrade": {
    tier: 2,
    execute: (params) => {
      if (!params.packages?.length) throw new Error("No packages specified");
      params.packages.forEach(validatePackageName);
      return run("apt-get", ["upgrade", "-y", "--only-upgrade", ...params.packages], 300000);
    },
  },
  "apt.autoremove": {
    tier: 1,
    execute: () => run("apt-get", ["autoremove", "-y"], 120000),
  },
  "apt.clean": {
    tier: 1,
    execute: () => run("apt-get", ["clean"], 60000),
  },
  "dpkg.list": {
    tier: 1,
    execute: () => run("dpkg-query", ["-W", "-f", "${Package} ${Version} ${Status}\n"], 60000),
  },
  "systemctl.status": {
    tier: 1,
    execute: (params) => {
      validateServiceName(params.service);
      return run("systemctl", ["status", params.service], 15000);
    },
  },
  "systemctl.is-active": {
    tier: 1,
    execute: (params) => {
      validateServiceName(params.service);
      return run("systemctl", ["is-active", params.service], 15000);
    },
  },
  "systemctl.restart": {
    tier: 2,
    execute: (params) => {
      validateServiceName(params.service);
      if (!SERVICE_WHITELIST.has(params.service)) throw new Error(`Service not whitelisted for restart: ${params.service}`);
      return run("systemctl", ["restart", params.service], 30000);
    },
  },
  "journalctl.vacuum": {
    tier: 1,
    execute: () => run("journalctl", ["--vacuum-time=7d"], 60000),
  },
  "file.truncate": {
    tier: 1,
    execute: (params) => {
      validateFilePath(params.target, SAFE_LOG_DIRS);
      return run("truncate", ["-s", "0", params.target], 15000);
    },
  },
  "file.find-large": {
    tier: 1,
    execute: (params) => {
      const dirs = params.dirs || ["/var/log"];
      dirs.forEach((d) => validateFilePath(d, ["/var/log", "/var/cache", "/tmp", "/var/lib/docker"]));
      return run("find", [...dirs, "-type", "f", "-size", `+${params.minMb || 50}M`, "-printf", "%s %p\\n"], 60000);
    },
  },
  "file.remove": {
    tier: 2,
    execute: (params) => {
      validateFilePath(params.target, ["/tmp", "/var/cache/apt"]);
      return run("rm", ["-f", params.target], 15000);
    },
  },
  "du.directory": {
    tier: 1,
    execute: (params) => {
      validateFilePath(params.dir, ["/var/log", "/var/cache", "/tmp", "/var/lib/docker", "/var/lib/postgresql"]);
      return run("du", ["-sh", params.dir], 30000);
    },
  },
  "df.summary": {
    tier: 1,
    execute: () => run("df", ["-h"], 15000),
  },
};
