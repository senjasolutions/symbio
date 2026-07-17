/**
 * Skills collector — bulk data gathering for Symbio Intelligence skills.
 * Returns requested data types in a single response to minimize bridge calls.
 */

import { execFile } from "node:child_process";
import { getServerInfo, getProcessList, getListeningPorts, getMemoryDetail, getDiskIO, getLoggedInUsers, getInstalledPackages } from "./system.js";
import { readSystemLog } from "./log-reader.js";

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
          result.serviceStatus = { services: [] };
          for (const name of services) {
            try {
              const active = await runCollect("systemctl", ["is-active", name], 15000);
              const proc = await runCollect("pgrep", ["-x", name], 5000);
              result.serviceStatus.services.push({
                name,
                isActive: (active.stdout || "").trim() || "unknown",
                processDetected: proc ? proc.exitCode === 0 : false,
              });
            } catch { result.serviceStatus.services.push({ name, isActive: "unknown", processDetected: false }); }
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
