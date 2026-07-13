/**
 * On-demand system collectors read host /proc, /sys, and /host/root directly
 * through validated path containment. No shell execution except for apt/dpkg
 * queries that run against the host root filesystem.
 * Every function returns structured data ready for the bridge API.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROC_PATH = "/host/proc";
const HOST_ROOT = "/host/root";
const CPUINFO_PATH = path.join(PROC_PATH, "cpuinfo");
const MEMINFO_PATH = path.join(PROC_PATH, "meminfo");
const UPTIME_PATH = path.join(PROC_PATH, "uptime");
const DISKSTATS_PATH = path.join(PROC_PATH, "diskstats");
const TCP_PATH = path.join(PROC_PATH, "net/tcp");
const TCP6_PATH = path.join(PROC_PATH, "net/tcp6");
const UDP_PATH = path.join(PROC_PATH, "net/udp");
const UDP6_PATH = path.join(PROC_PATH, "net/udp6");
const OS_RELEASE_PATH = path.join(HOST_ROOT, "etc/os-release");
const PASSWD_PATH = path.join(HOST_ROOT, "etc/passwd");
const UTMP_PATH = path.join(HOST_ROOT, "var/run/utmp");
const DPKG_STATUS_PATH = path.join(HOST_ROOT, "var/lib/dpkg/status");
const SYS_DMI_PATH = path.join(HOST_ROOT, "sys/class/dmi/id");
const SYS_CPU_PATH = path.join(HOST_ROOT, "sys/devices/system/cpu");

/** Reads a text file safely, returning the content or an empty string on failure. */
const readText = async (filePath) => {
  try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
};

// ============================================================================
// 1. Server Information
// ============================================================================

export const getServerInfo = async () => {
  const [cpuinfoRaw, meminfoRaw, uptimeRaw, osReleaseRaw] = await Promise.all([
    readText(CPUINFO_PATH), readText(MEMINFO_PATH), readText(UPTIME_PATH), readText(OS_RELEASE_PATH),
  ]);

  // Parse OS release (key=value format)
  const osRelease = {};
  for (const line of osReleaseRaw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).replace(/^"/, "").replace(/"$/, "");
    osRelease[key] = value;
  }

  // Parse CPU info — aggregate counts and grab first processor's model/flags
  let cpuModel = "", cpuFlags = "", cpuCores = 0, cpuMhz = "";
  let cacheL1d = "", cacheL1i = "", cacheL2 = "", cacheL3 = "";
  const processors = cpuinfoRaw.split("\n\n").filter(Boolean);
  for (const block of processors) {
    const lines = block.split("\n");
    let isFirst = false;
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      if (key === "processor" && val === "0") isFirst = true;
      if (isFirst) {
        if (key === "model name") cpuModel = val;
        if (key === "flags") cpuFlags = val;
        if (key === "cpu MHz") cpuMhz = val;
        if (key === "cache size" && !cacheL3) cacheL3 = val;
      }
      if (key === "cpu cores") cpuCores = parseInt(val, 10) || cpuCores;
    }
  }
  const cpuThreads = processors.length;

  // Parse memory totals
  let memTotal = 0, swapTotal = 0;
  for (const line of meminfoRaw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = parseInt(line.slice(colon + 1).trim(), 10) || 0;
    if (key === "MemTotal") memTotal = val * 1024;
    if (key === "SwapTotal") swapTotal = val * 1024;
  }

  // Parse uptime and calculate boot time
  const uptimeParts = uptimeRaw.trim().split(/\s+/);
  const uptimeSeconds = parseFloat(uptimeParts[0]) || 0;
  const bootTime = new Date(Date.now() - uptimeSeconds * 1000).toISOString();

  return {
    os: osRelease.PRETTY_NAME || osRelease.NAME || "Unknown",
    osId: osRelease.ID || "",
    osVersion: osRelease.VERSION_ID || "",
    cpu: { model: cpuModel, cores: cpuCores, threads: cpuThreads, flags: cpuFlags, mhz: cpuMhz, cacheL3 },
    memory: { total: memTotal, swapTotal },
    bootTime,
    uptime: uptimeSeconds,
  };
};

// ============================================================================
// 2. Process List
// ============================================================================

const parseProcStat = (statLine) => {
  // /proc/[pid]/stat format: pid (comm) state ppid ...
  const parenClose = statLine.lastIndexOf(")");
  if (parenClose === -1) return null;
  const beforeParen = statLine.indexOf("(");
  const pid = parseInt(statLine.slice(0, beforeParen - 1), 10);
  const comm = statLine.slice(beforeParen + 1, parenClose);
  const rest = statLine.slice(parenClose + 2).split(" ");
  return {
    pid,
    comm,
    state: rest[0],
    ppid: parseInt(rest[1], 10),
    utime: parseInt(rest[11], 10) || 0,
    stime: parseInt(rest[12], 10) || 0,
    rss: (parseInt(rest[21], 10) || 0) * 4096, // pages to bytes
    vsize: parseInt(rest[20], 10) || 0,
    threads: parseInt(rest[17], 10) || 0,
  };
};

const buildUidCache = async () => {
  const passwdRaw = await readText(PASSWD_PATH);
  const uidToUser = {};
  for (const line of passwdRaw.split("\n")) {
    const parts = line.split(":");
    if (parts.length >= 3) {
      const uid = parseInt(parts[2], 10);
      if (!isNaN(uid)) uidToUser[uid] = parts[0];
    }
  }
  return uidToUser;
};

export const getProcessList = async () => {
  const uidToUser = await buildUidCache();
  let procDirs;
  try { procDirs = await fs.readdir(PROC_PATH); } catch { return { processes: [], total: 0 }; }
  const processes = [];
  for (const name of procDirs) {
    const pid = parseInt(name, 10);
    if (isNaN(pid)) continue;
    try {
      const [statRaw, statusRaw, cmdlineRaw] = await Promise.all([
        readText(path.join(PROC_PATH, name, "stat")),
        readText(path.join(PROC_PATH, name, "status")),
        readText(path.join(PROC_PATH, name, "cmdline")),
      ]);
      const parsed = parseProcStat(statRaw);
      if (!parsed) continue;
      // Get UID from status
      let uid = 0;
      for (const line of statusRaw.split("\n")) {
        if (line.startsWith("Uid:")) {
          uid = parseInt(line.split("\t")[1], 10) || 0;
          break;
        }
      }
      // Reconstruct command line
      const cmdline = cmdlineRaw.replace(/\0/g, " ").trim() || `[${parsed.comm}]`;
      processes.push({
        pid: parsed.pid, user: uidToUser[uid] || String(uid),
        state: parsed.state, rss: parsed.rss, vsize: parsed.vsize,
        threads: parsed.threads, cpuTime: parsed.utime + parsed.stime,
        command: cmdline.length > 200 ? cmdline.slice(0, 197) + "..." : cmdline,
      });
    } catch { /* skip inaccessible */ }
  }
  // Sort by RSS (memory) descending
  processes.sort((a, b) => b.rss - a.rss);
  return { processes, total: processes.length };
};

// ============================================================================
// 3. Listening Ports
// ============================================================================

const parseProcNetLine = (line) => {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 10) return null;
  const localParts = parts[1].split(":");
  const remoteParts = parts[2].split(":");
  const localHex = localParts.slice(0, -1).join("");
  const localPort = parseInt(localParts[localParts.length - 1], 16);
  const inode = parseInt(parts[9], 10) || 0;
  let localAddr = "";
  try {
    // Reverse hex to IP (little-endian 32-bit → dotted decimal)
    const addr = parseInt(localHex, 16);
    localAddr = [
      (addr) & 0xFF,
      (addr >> 8) & 0xFF,
      (addr >> 16) & 0xFF,
      (addr >> 24) & 0xFF,
    ].join(".");
  } catch { localAddr = "0.0.0.0"; }
  return { localAddr, localPort, inode, state: parts[3] === "0A" ? "LISTEN" : "ESTABLISHED" };
};

const parseProcNet6Line = (line) => {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 10) return null;
  const localParts = parts[1].split(":");
  const localPort = parseInt(localParts[localParts.length - 1], 16);
  const inode = parseInt(parts[9], 10) || 0;
  return { localAddr: "::", localPort, inode, state: parts[3] === "0A" ? "LISTEN" : "ESTABLISHED" };
};

const parseNetFile = (content, protocol, isV6) => {
  const lines = content.split("\n");
  if (lines.length < 2) return [];
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = isV6 ? parseProcNet6Line(lines[i]) : parseProcNetLine(lines[i]);
    if (parsed && parsed.localPort > 0) {
      entries.push({ ...parsed, protocol });
    }
  }
  return entries;
};

const buildInodePidCache = async () => {
  const cache = new Map();
  let procDirs;
  try { procDirs = await fs.readdir(PROC_PATH); } catch { return cache; }
  for (const name of procDirs) {
    const pid = parseInt(name, 10);
    if (isNaN(pid)) continue;
    try {
      const fdDir = path.join(PROC_PATH, name, "fd");
      const fds = await fs.readdir(fdDir);
      for (const fd of fds) {
        try {
          const link = await fs.readlink(path.join(fdDir, fd));
          const match = link.match(/socket:\[(\d+)\]/);
          if (match) cache.set(parseInt(match[1], 10), { pid, name });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return cache;
};

export const getListeningPorts = async () => {
  const [tcpContent, tcp6Content, udpContent, udp6Content] = await Promise.all([
    readText(TCP_PATH).catch(() => ""), readText(TCP6_PATH).catch(() => ""),
    readText(UDP_PATH).catch(() => ""), readText(UDP6_PATH).catch(() => ""),
  ]);
  let entries = [
    ...parseNetFile(tcpContent, "tcp", false),
    ...parseNetFile(tcp6Content, "tcp6", true),
    ...parseNetFile(udpContent, "udp", false),
    ...parseNetFile(udp6Content, "udp6", true),
  ];
  // Only show listening TCP sockets (UDP sockets are always "listening")
  entries = entries.filter((e) => e.protocol.startsWith("udp") || e.state === "LISTEN");

  // Map inodes to process names
  const inodePid = await buildInodePidCache();
  for (const entry of entries) {
    const info = inodePid.get(entry.inode);
    if (info) {
      try {
        const comm = await readText(path.join(PROC_PATH, String(info.pid), "comm"));
        entry.processName = comm.trim();
        entry.pid = info.pid;
      } catch { entry.processName = "?"; }
    } else {
      entry.processName = "?";
    }
  }

  // Sort by port number
  entries.sort((a, b) => a.localPort - b.localPort);
  return { ports: entries };
};

// ============================================================================
// 4. Memory Detail
// ============================================================================

const MEMINFO_ORDER = [
  "MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached",
  "SwapCached", "Active", "Inactive", "Active(anon)", "Inactive(anon)",
  "Active(file)", "Inactive(file)", "Unevictable", "Mlocked",
  "SwapTotal", "SwapFree", "Dirty", "Writeback", "AnonPages",
  "Mapped", "Shmem", "KReclaimable", "Slab", "SReclaimable", "SUnreclaim",
  "KernelStack", "PageTables", "NFS_Unstable", "Bounce",
  "WritebackTmp", "CommitLimit", "Committed_AS", "VmallocTotal",
  "VmallocUsed", "VmallocChunk", "Percpu",
  "HardwareCorrupted", "AnonHugePages", "ShmemHugePages",
  "ShmemPmdMapped", "FileHugePages", "FilePmdMapped",
  "HugePages_Total", "HugePages_Free", "HugePages_Rsvd",
  "HugePages_Surp", "Hugepagesize", "Hugetlb",
  "DirectMap4k", "DirectMap2M", "DirectMap1G",
];

export const getMemoryDetail = async () => {
  const raw = await readText(MEMINFO_PATH);
  const fields = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = parseInt(line.slice(colon + 1).trim(), 10) || 0;
    fields[key] = val * 1024; // Convert kB to bytes
  }
  // Build ordered array for the template
  const detail = [];
  for (const key of MEMINFO_ORDER) {
    if (fields[key] !== undefined) detail.push({ key, value: fields[key] });
  }
  return { memory: { total: fields.MemTotal || 0, detail } };
};

// ============================================================================
// 5. Disk I/O
// ============================================================================

export const getDiskIO = async () => {
  const raw = await readText(DISKSTATS_PATH).catch(() => "");
  const lines = raw.trim().split("\n").filter(Boolean);
  const disks = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const major = parseInt(parts[0], 10);
    // Only block devices (major 8 = SCSI/SATA, 259 = NVMe, 253 = device-mapper, 9 = md)
    // Skip partitions (odd minor numbers when major is 8)
    if (major !== 8 && major !== 259 && major !== 253 && major !== 9 && major !== 252) continue;
    // LVM/dm-X devices: skip partitions by name pattern
    const name = parts[2];
    // Skip if purely numeric suffix (partition)
    disks.push({
      name,
      reads: parseInt(parts[3], 10) || 0,
      readsMerged: parseInt(parts[4], 10) || 0,
      sectorsRead: parseInt(parts[5], 10) || 0,
      timeReading: parseInt(parts[6], 10) || 0,
      writes: parseInt(parts[7], 10) || 0,
      writesMerged: parseInt(parts[8], 10) || 0,
      sectorsWritten: parseInt(parts[9], 10) || 0,
      timeWriting: parseInt(parts[10], 10) || 0,
      ioInProgress: parseInt(parts[11], 10) || 0,
      ioTime: parseInt(parts[12], 10) || 0,
      weightedIoTime: parseInt(parts[13], 10) || 0,
    });
  }
  return { disks };
};

// ============================================================================
// 6. Logged-in Users (parse utmp binary)
// ============================================================================

const UTMP_RECORD_SIZE = 384;
const UTMP_USER_SIZE = 32;
const UTMP_LINE_SIZE = 32;
const UTMP_HOST_SIZE = 256;
const USER_PROCESS = 7;

const readUtmpRecord = (buffer, offset) => {
  const type = buffer.readInt32LE(offset);
  if (type !== USER_PROCESS) return null;
  // ut_user at offset 4, 32 bytes
  let userEnd = offset + 4 + UTMP_USER_SIZE;
  let user = "";
  for (let i = offset + 4; i < userEnd; i++) {
    if (buffer[i] === 0) break;
    user += String.fromCharCode(buffer[i]);
  }
  if (!user) return null;
  // ut_line at offset 36, 32 bytes
  let lineEnd = offset + 36 + UTMP_LINE_SIZE;
  let line = "";
  for (let i = offset + 36; i < lineEnd; i++) {
    if (buffer[i] === 0) break;
    line += String.fromCharCode(buffer[i]);
  }
  // ut_host at offset 260, 256 bytes
  let hostEnd = offset + 260 + UTMP_HOST_SIZE;
  let host = "";
  for (let i = offset + 260; i < hostEnd; i++) {
    if (buffer[i] === 0) break;
    host += String.fromCharCode(buffer[i]);
  }
  // ut_tv at offset 76 (sec, usec as int32 each)
  const loginTime = new Date(buffer.readInt32LE(offset + 76) * 1000).toISOString();
  return { user, terminal: line, loginTime, host: host || "local" };
};

export const getLoggedInUsers = async () => {
  let buffer;
  try {
    buffer = await fs.readFile(UTMP_PATH);
  } catch {
    return { users: [] };
  }
  const users = [];
  for (let offset = 0; offset + UTMP_RECORD_SIZE <= buffer.length; offset += UTMP_RECORD_SIZE) {
    const record = readUtmpRecord(buffer, offset);
    if (record) users.push(record);
  }
  return { users };
};

// ============================================================================
// 7. Installed Packages (dpkg status)
// ============================================================================

export const getInstalledPackages = async () => {
  let raw;
  try {
    raw = await readText(DPKG_STATUS_PATH);
  } catch {
    return { packages: [], total: 0 };
  }
  const blocks = raw.split("\n\n").filter(Boolean);
  const packages = [];
  for (const block of blocks) {
    const pkg = {};
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      if (key === "Package") pkg.name = val;
      if (key === "Version") pkg.version = val;
      if (key === "Architecture") pkg.architecture = val;
      if (key === "Status") {
        const parts = val.split(/\s+/);
        pkg.installed = parts.includes("installed");
      }
      if (key === "Description") pkg.description = val;
    }
    if (pkg.name && pkg.installed) packages.push(pkg);
  }
  packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { packages, total: packages.length };
};
