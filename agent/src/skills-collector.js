/**
 * Skills collector — bulk data gathering for Symbio Intelligence skills.
 * Returns requested data types in a single response to minimize bridge calls.
 */

import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { getServerInfo, getProcessList, getListeningPorts, getMemoryDetail, getDiskIO, getLoggedInUsers, getInstalledPackages } from "./system.js";
import { readSystemLog } from "./log-reader.js";

/**
 * Maps service names to process comm names found in /proc/PID/comm.
 * Mirrors the mapping in components/services/index.js but kept inline
 * to avoid coupling the collector to the component registry.
 */
const SERVICE_PROCESS_NAMES = {
  nginx: ["nginx"],
  apache2: ["apache2", "httpd"],
  mysql: ["mysqld", "mariadbd"],
  postgresql: ["postgres"],
  "redis-server": ["redis-server"],
  docker: ["dockerd"],
  pm2: ["pm2"],
};

/**
 * Scans /host/proc for running processes by reading each PID's comm file.
 * Also checks cmdline for processes that may have different comm names
 * (e.g. pm2 runs as "node" under NVM, or "PM2 v5.2.2: God" as its title).
 * Returns a Set of normalized process names (lowercase).
 */
const scanHostProcesses = async () => {
  const found = new Set();
  let entries;
  try {
    entries = await fs.readdir("/host/proc", { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const comm = (await fs.readFile(path.join("/host/proc", entry.name, "comm"), "utf8")).trim().toLowerCase();
      if (!comm) continue;
      found.add(comm);
      // pm2 sets its process title to "PM2 vX.Y.Z: God" — the trimmed comm
      // won't match "pm2" exactly. Also check cmdline for known manager names.
      if (comm.startsWith("pm2") || comm.includes("pm2")) found.add("pm2");
      try {
        const cmdline = (await fs.readFile(path.join("/host/proc", entry.name, "cmdline"), "utf8")).toLowerCase();
        if (cmdline.includes("pm2")) found.add("pm2");
      } catch {}
    } catch {}
  }
  return found;
};

/** Collects requested data types from the host system. */
export const collectSkillData = async (config, collectTypes, options) => {
  const result = {};
  const errors = {};

  for (const type of collectTypes) {
    try {
      switch (type) {
        case "packages": {
          // Check if apt/dpkg is locked before attempting collection
          const lockFiles = ["/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"];
          let isLocked = false;
          for (const lf of lockFiles) {
            const lockCheck = await runCollect("fuser", [lf], 5000);
            if (lockCheck.exitCode === 0) { isLocked = true; break; }
          }
          if (isLocked) {
            result.packages = { installed: [], isLocked: true };
            break;
          }
          const [installed, updates] = await Promise.allSettled([
            getInstalledPackages(),
            runCollect("apt.list-upgradable", "apt", ["list", "--upgradable"], 60000),
          ]);
          result.packages = {
            installed: installed.status === "fulfilled" ? (installed.value.packages || []) : [],
            updates: parsePackageUpdates(updates.status === "fulfilled" ? updates.value.stdout : ""),
            isLocked: false,
          };
          break;
        }
        case "disk": {
          const [df, journalctl] = await Promise.allSettled([
            runCollect("df", ["-h"], 15000),
            runCollect("journalctl", ["--disk-usage"], 15000),
          ]);
          result.disk = {
            disks: parseDfOutput(df.status === "fulfilled" ? df.value.stdout : ""),
            journalctlSize: journalctl.status === "fulfilled" ? (journalctl.value.stdout || "").trim() : "",
          };
          if (options.largeFilesMinMb && options.largeFilesDirs) {
            const large = await runCollect("find",
              [...options.largeFilesDirs, "-type", "f", "-size", `+${options.largeFilesMinMb}M`, "-printf", "%s %p\\n"],
              60000,
            );
            result.disk.largeFiles = large ? parseLargeFiles(large.stdout) : [];
          }
          break;
        }
        case "logs": {
          const sources = options.logSources || ["syslog"];
          const lines = options.logLines || 100;
          result.logs = {};
          for (const source of sources) {
            try {
              const log = await readSystemLog(config.hostRootPath, `/var/log/${source}.log`, String(lines));
              result.logs[source] = log.text.split("\n").slice(0, lines);
            } catch { result.logs[source] = []; }
          }
          break;
        }
        case "service-status": {
          const services = options.services || [];
          const processes = await scanHostProcesses();
          result.serviceStatus = { services: [] };
          for (const name of services) {
            // Check if any known process name for this service is running
            const procNames = SERVICE_PROCESS_NAMES[name] || [name];
            const processDetected = procNames.some((p) => processes.has(p));
            result.serviceStatus.services.push({
              name,
              isActive: processDetected ? "active" : "unknown",
              processDetected,
            });
          }
          break;
        }
        case "server-info":
          result.serverInfo = await getServerInfo();
          break;
        case "processes":
          result.processes = await getProcessList();
          break;
        case "ports":
          result.ports = await getListeningPorts();
          break;
        case "failed-logins": {
          const fb = await runCollect("lastb", ["-n", String(options.maxFailedLogins || 50)], 15000);
          result.failedLogins = (fb.stdout || "").split("\n").filter(Boolean).slice(0, options.maxFailedLogins || 50);
          break;
        }
        case "recent-logins": {
          const l = await runCollect("last", ["-n", "20"], 15000);
          result.recentLogins = (l.stdout || "").split("\n").filter(Boolean).slice(0, 20);
          break;
        }
        case "network": {
          const s = await runCollect("ss", ["-tunap"], 15000);
          result.network = (s.stdout || "").split("\n").filter(Boolean).slice(0, 100);
          break;
        }
        case "crontabs": {
          const lines = [];
          for (const user of ["root", "www-data", "nobody", "ubuntu", "admin", "deploy"]) {
            try {
              const c = await runCollect("crontab", ["-l", "-u", user], 10000);
              if (c.stdout?.trim()) lines.push(`--- ${user} ---\n${c.stdout.trim()}`);
            } catch {}
          }
          // Also check /etc/crontab and /etc/cron.d
          try {
            const r = await runCollect("cat", ["/etc/crontab"], 10000);
            if (r.stdout?.trim()) lines.push(`--- /etc/crontab ---\n${r.stdout.trim()}`);
          } catch {}
          try {
            const dir = await runCollect("ls", ["/etc/cron.d"], 10000);
            if (dir.stdout?.trim()) lines.push("--- /etc/cron.d ---\n" + dir.stdout.trim());
          } catch {}
          result.crontabs = lines;
          break;
        }
        case "memory":
          result.memory = await getMemoryDetail();
          break;
        case "users":
          result.users = await getLoggedInUsers();
          break;
        case "docker": {
          result.docker = await collectDockerData();
          break;
        }
      }
    } catch (error) {
      errors[type] = error.message;
    }
  }

  if (Object.keys(errors).length) result.collectErrors = errors;
  return result;
};

/** Runs a simple execFile with promise wrapper. */
const runCollect = (cmd, args, timeout) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
    resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: error?.code || 0 });
  });
  child.on("error", () => resolve({ stdout: "", stderr: "", exitCode: -1 }));
});

const DOCKER_SOCKET = "/var/run/docker.sock";

/** Makes a GET request to the Docker engine API over the UNIX socket. */
const dockerApi = (apiPath) => new Promise((resolve, reject) => {
  const req = http.get({ socketPath: DOCKER_SOCKET, path: apiPath }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Parse failed")); }
    });
  });
  req.on("error", reject);
  req.end();
});

/** Collects Docker container list and disk usage via the Docker API socket. */
const collectDockerData = async () => {
  try {
    const [containersJson, dfJson] = await Promise.all([
      dockerApi("/containers/json?all=true"),
      dockerApi("/system/df"),
    ]);

    // Map Docker API container JSON to the same format parseDockerContainerSummary expects
    const containers = (containersJson || []).map((c) => {
      const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : "";
      const running = c.State === "running";
      const exited = c.State === "exited";
      const restarting = c.State === "restarting";
      return { name, status: (c.Status || "").slice(0, 80), running, exited, restarting };
    });

    // Map Docker API system/df JSON to the same format parseDockerDf expects
    const diskUsage = {};
    if (dfJson) {
      const categories = [
        { key: "images", total: dfJson.Images, label: "Images" },
        { key: "containers", total: dfJson.Containers, label: "Containers" },
        { key: "volumes", total: dfJson.Volumes, label: "Local Volumes" },
        { key: "build_cache", total: dfJson.BuildCache, label: "Build Cache" },
      ];
      for (const cat of categories) {
        if (cat.total) {
          diskUsage[cat.key] = {
            total: cat.total.TotalCount || 0,
            active: cat.total.ActiveCount || 0,
            size: cat.total.Size ? formatDockerBytes(cat.total.Size) : "0B",
            reclaimable: cat.total.ReclaimableSize ? formatDockerBytes(cat.total.ReclaimableSize) : "0B",
          };
        }
      }
    }

    return { containers, diskUsage };
  } catch {
    return { containers: [], diskUsage: {} };
  }
};

/** Formats a byte count from Docker API into a human-readable string. */
const formatDockerBytes = (bytes) => {
  if (bytes == null) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)}MB`;
  return `${(bytes / 1073741824).toFixed(2)}GB`;
};

/** Parses `apt list --upgradable` output into structured objects. */
const parsePackageUpdates = (text) => {
  const updates = [];
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Listing...") || !trimmed.includes("/")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const pkgName = parts[0].split("/")[0];
      const versionInfo = parts[1] || "";
      const newVersion = versionInfo.includes("=>") ? versionInfo.split("=>").pop().trim() : versionInfo;
      updates.push({ pkg: pkgName, version: "", newVersion });
    }
  }
  return updates;
};

/** Parses `df -h` output into structured disk objects. */
const parseDfOutput = (text) => {
  const disks = [];
  for (const line of (text || "").split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6 && parts[0].startsWith("/")) {
      disks.push({
        filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3],
        usePercent: parseInt(parts[4]), mount: parts[5],
      });
    }
  }
  return disks;
};

/** Parses `find -printf` output into structured file objects. */
const parseLargeFiles = (text) => {
  const files = [];
  for (const line of (text || "").split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    if (space > 0) {
      const size = parseInt(line.slice(0, space));
      const path = line.slice(space + 1);
      if (path) files.push({ path, sizeBytes: size, sizeMb: Math.round(size / (1024 * 1024)) });
    }
  }
  return files;
};

/** Parses `find -printf` output into structured file objects. */
