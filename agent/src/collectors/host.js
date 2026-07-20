/** Read-only host collector derives metrics from mounted procfs and statfs without shell commands. */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

let previousCpu = new Map();
let previousNet = { timestamp: 0, rxBytes: 0, txBytes: 0 };

const IGNORED_FILESYSTEMS = new Set(["autofs", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts", "devtmpfs", "efivarfs", "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay", "proc", "pstore", "ramfs", "securityfs", "sysfs", "tmpfs", "tracefs"]);

/** Reads a host pseudo-file and returns an empty string when the kernel hides it. */
const readHostFile = async (relativePath) => {
  try { return await fs.readFile(path.join(config.procPath, relativePath), "utf8"); } catch { return ""; }
};

/** Parses aggregate and logical-core /proc/stat counters into interval utilization.
 * /proc/stat cpu fields (0-based): 0=user 1=nice 2=system 3=idle 4=iowait 5=irq 6=softirq 7=steal 8=guest 9=guest_nice
 * CPU busy = total - idle (iowait is busy time — CPU had work waiting on I/O).
 * IOWait is tracked separately for alert rules that monitor disk I/O pressure. */
const collectCpu = async () => {
  const counters = (await readHostFile("stat")).split("\n").filter((line) => /^cpu(?:\d+)?\s/.test(line));
  const readings = counters.map((line) => {
    const [label, ...rawValues] = line.trim().split(/\s+/);
    const values = rawValues.map(Number);
    // Guard against NaN from corrupt /proc/stat
    for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) values[i] = 0;
    const current = { idle: (values[3] || 0) + (values[4] || 0), iowait: (values[4] || 0), total: values.reduce((sum, value) => sum + value, 0) };
    const previous = previousCpu.get(label);
    previousCpu.set(label, current);
    const totalDelta = current.total - (previous?.total || current.total);
    const idleDelta = current.idle - (previous?.idle || current.idle);
    const iowaitDelta = current.iowait - (previous?.iowait || current.iowait);
    const percent = previous && totalDelta > 0 ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)) : null;
    const iowaitPercent = previous && totalDelta > 0 ? Math.max(0, Math.min(100, (iowaitDelta / totalDelta) * 100)) : null;
    return { label, percent, iowaitPercent };
  });
  const aggregate = readings.find((reading) => reading.label === "cpu");
  return { cpuPercent: aggregate?.percent ?? null, cpuIowaitPercent: aggregate?.iowaitPercent ?? null, cpuCores: readings.filter((reading) => reading.label !== "cpu").map((reading) => ({ id: reading.label, percent: reading.percent })) };
};

/** Parses meminfo using MemAvailable so cache is not misreported as consumed RAM. */
const collectMemory = async () => {
  const entries = Object.fromEntries((await readHostFile("meminfo")).split("\n").map((line) => {
    const [key, raw] = line.split(":");
    const val = Number.isFinite(Number.parseInt(raw, 10)) ? Number.parseInt(raw, 10) * 1024 : null;
    return [key, val];
  }));
  const total = entries.MemTotal || null;
  const available = entries.MemAvailable ?? entries.MemFree ?? null;
  const used = total != null && available != null ? total - available : null;
  const swapTotal = entries.SwapTotal || null;
  const swapFree = entries.SwapFree ?? null;
  return {
    memoryUsedBytes: used, memoryAvailableBytes: available, memoryTotalBytes: total, memoryPercent: total ? (used / total) * 100 : null,
    swapUsedBytes: swapTotal != null && swapFree != null ? swapTotal - swapFree : null, swapTotalBytes: swapTotal,
  };
};

/** Decodes mountinfo escapes so host paths can be joined safely below the fixed root bind. */
const decodeMountPath = (value) => value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\");

/** Returns usable host filesystems, excluding kernel, temporary, Snap, and duplicate bind mounts. */
const collectStorage = async () => {
  const mountInfo = await readHostFile("1/mountinfo");
  const seen = new Set();
  const filesystems = [];
  for (const line of mountInfo.split("\n")) {
    const [before, after] = line.split(" - ");
    const fields = before?.split(" ") || [];
    const suffix = after?.split(" ") || [];
    const mountPoint = decodeMountPath(fields[4] || "");
    const [fsType, source] = suffix;
    if (!mountPoint.startsWith("/") || !fsType || IGNORED_FILESYSTEMS.has(fsType) || mountPoint.startsWith("/snap/")) continue;
    const key = `${fsType}:${source || ""}`;
    if (seen.has(key)) continue;
    try {
      const stats = await fs.statfs(path.join(config.hostRootPath, mountPoint), { bigint: true });
      const totalBytes = Number(stats.blocks * stats.bsize);
      const availableBytes = Number(stats.bavail * stats.bsize);
      if (!totalBytes || !Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)) continue;
      seen.add(key);
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      filesystems.push({ mountPoint, fsType, source: String(source || "").slice(0, 255), totalBytes, usedBytes, availableBytes });
    } catch { /* A mount can disappear while the host is being inspected. */ }
  }
  return filesystems;
};

/** Uses the root filesystem record as the compact dashboard disk metric. */
const rootDiskMetrics = (storage) => {
  const root = storage.find((entry) => entry.mountPoint === "/") || storage[0];
  if (!root) return { diskUsedBytes: null, diskTotalBytes: null, diskPercent: null };
  return { diskUsedBytes: root.usedBytes, diskTotalBytes: root.totalBytes, diskPercent: root.totalBytes > 0 ? Math.min(100, (root.usedBytes / root.totalBytes) * 100) : null };
};

/** Reads stable CPU identity fields without executing host commands. */
const collectHardware = async () => {
  const cpuInfo = await readHostFile("cpuinfo");
  const model = /(?:model name|Hardware)\s*:\s*(.+)/i.exec(cpuInfo)?.[1]?.trim() || os.arch();
  const logicalCores = (cpuInfo.match(/^processor\s*:/gm) || []).length || os.cpus().length;
  return { architecture: os.arch(), cpuModel: model.slice(0, 255), logicalCores };
};

/** Collects host interface identity, addresses, and read-only counter files. */
const collectNetworking = async () => {
  const counters = Object.fromEntries((await readHostFile("net/dev")).split("\n").slice(2).map((line) => {
    const [name, values] = line.trim().split(":");
    const fields = values?.trim().split(/\s+/).map((v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; }) || [];
    return [name?.trim(), { rxBytes: fields[0] || 0, txBytes: fields[8] || 0 }];
  }).filter(([name]) => name));
  return Promise.all(Object.entries(os.networkInterfaces()).map(async ([name, addresses]) => {
    const root = path.join(config.hostRootPath, "sys/class/net", name);
    const read = async (file) => { try { return (await fs.readFile(path.join(root, file), "utf8")).trim(); } catch { return ""; } };
    const [state, mtu, speed] = await Promise.all([read("operstate"), read("mtu"), read("speed")]);
    return { name, state: state || "unknown", mac: addresses.find((entry) => entry.mac && entry.mac !== "00:00:00:00:00:00")?.mac || "—", mtu: Number(mtu) || null, speedMbps: Number(speed) > 0 ? Number(speed) : null, addresses: addresses.filter((entry) => !entry.internal).map((entry) => ({ family: entry.family, address: entry.address, netmask: entry.netmask })), ...(counters[name] || { rxBytes: 0, txBytes: 0 }) };
  }));
};

/** Reads NAME/PRETTY_NAME values from the exact mounted Ubuntu metadata file. */
const operatingSystem = async () => {
  try {
    const content = await fs.readFile(config.osReleasePath, "utf8");
    const match = /^PRETTY_NAME=(.*)$/m.exec(content);
    return match ? match[1].replace(/^"|"$/g, "") : "Linux";
  } catch { return "Linux"; }
};

/** Returns aggregate network throughput (bytes/sec) from /proc/net/dev deltas. */
const collectNetworkThroughput = async () => {
  const raw = await readHostFile("net/dev");
  const lines = raw.trim().split("\n").slice(2);
  let totalRx = 0, totalTx = 0;
  for (const line of lines) {
    const [name, values] = line.trim().split(":");
    const fields = values?.trim().split(/\s+/).map((v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; }) || [];
    if (name?.trim() === "lo") continue;
    totalRx += fields[0] || 0;
    totalTx += fields[8] || 0;
  }
  const now = Date.now();
  const elapsed = (now - previousNet.timestamp) / 1000;
  let rxPerSec = null, txPerSec = null;
  if (previousNet.timestamp > 0 && elapsed > 0) {
    rxPerSec = Math.max(0, (totalRx - previousNet.rxBytes) / elapsed);
    txPerSec = Math.max(0, (totalTx - previousNet.txBytes) / elapsed);
  }
  previousNet = { timestamp: now, rxBytes: totalRx, txBytes: totalTx };
  return { networkRxBytesPerSec: rxPerSec, networkTxBytesPerSec: txPerSec };
};

/** Collects one consistent host identity and metrics snapshot. */
export const collectHost = async () => {
  const [cpu, memory, storage, hardware, networking, loadText, uptimeText, kernelVersion, osName, netThroughput] = await Promise.all([
    collectCpu(), collectMemory(), collectStorage(), collectHardware(), collectNetworking(), readHostFile("loadavg"), readHostFile("uptime"),
    readHostFile("sys/kernel/osrelease"), operatingSystem(), collectNetworkThroughput(),
  ]);
  const loads = loadText.trim().split(/\s+/).slice(0, 3).map((v) => { const n = Number(v); return Number.isFinite(n) ? n : null; });
  let hostname = os.hostname();
  try { hostname = (await fs.readFile(config.hostnamePath, "utf8")).trim() || hostname; } catch { /* UTS hostname is the fallback. */ }
  return {
    host: { hostname, primaryIp: config.serverIp, operatingSystem: osName, kernelVersion: kernelVersion.trim(), hardware, storage, networking },
    metrics: {
      ...cpu, ...memory, ...rootDiskMetrics(storage), ...netThroughput,
      load1: loads[0] ?? null, load5: loads[1] ?? null, load15: loads[2] ?? null,
      uptimeSeconds: Math.floor(Number(uptimeText.split(" ")[0])) || null,
    },
  };
};

/** Scans only process identity files and returns normalized evidence without persisting raw arguments. */
export const collectProcesses = async () => {
  const found = new Set();
  let entries = [];
  try { entries = await fs.readdir(config.procPath, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const comm = (await fs.readFile(path.join(config.procPath, entry.name, "comm"), "utf8")).trim().toLowerCase();
      if (comm) found.add(comm);
      // pm2 sets its process title to "PM2 vX.Y.Z: God" — exact comm won't match "pm2".
      // Also check cmdline for manager names like pm2 (runs under node, python, etc.).
      if (comm.startsWith("pm2") || comm.includes("pm2")) found.add("pm2");
      try {
        const cmdline = (await fs.readFile(path.join(config.procPath, entry.name, "cmdline"), "utf8")).toLowerCase();
        if (cmdline.includes("pm2")) found.add("pm2");
      } catch {}
    } catch {
      // hidepid and normal process races make an unreadable or exited PID non-fatal.
    }
  }
  return found;
};
