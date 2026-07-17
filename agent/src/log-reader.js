/**
 * Registered application-log reader keeps host file access bounded and tied to
 * mothership configuration; it never accepts a browser-supplied path or shell command.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const TAIL_LIMITS = new Set([50, 100, 200, 500, 1000]);
export const MAX_TAIL_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_SEARCH_SCAN_BYTES = 8 * 1024 * 1024;
export const SEARCH_MATCH_LIMIT = 5;
export const SEARCH_CONTEXT_LINES = 10;

/** Validates log path — when `relaxed` is false (default), blocks Docker/PM2 paths. */
const validateHostPath = (filePath, relaxed = false) => {
  if (typeof filePath !== "string" || !path.posix.isAbsolute(filePath) || filePath.includes("\0")) throw new Error("Registered log path is invalid.");
  if (filePath.split("/").includes("..")) throw new Error("Registered log path contains traversal.");
  if (!relaxed) {
    if (filePath.startsWith("/var/lib/docker/") || filePath.split("/").includes(".pm2")) throw new Error("Docker and PM2 logs are not supported.");
  }
  return filePath;
};

/** Maps an approved absolute host path under the fixed read-only host-root bind. */
const mountedPath = (hostRootPath, filePath, relaxed = false) => {
  const root = path.resolve(hostRootPath);
  const target = path.resolve(root, `.${validateHostPath(filePath, relaxed)}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Registered log path escapes host root.");
  return { root, target };
};

/** Opens one regular non-symlink file with a Linux no-follow descriptor where available. */
const openRegisteredFile = async (hostRootPath, filePath, relaxed = false) => {
  const { root, target } = mountedPath(hostRootPath, filePath, relaxed);
  const entry = await fs.lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Registered log is not a regular file.");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("Registered log resolves outside host root.");
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  const stats = await handle.stat();
  if (!stats.isFile()) { await handle.close(); throw new Error("Registered log changed to a non-regular file."); }
  return { handle, stats };
};

/** Limits one untrusted log line while clearly retaining the fact that it was shortened. */
export const boundedLine = (line) => {
  const source = Buffer.from(line);
  return source.length <= MAX_LINE_BYTES ? line : `${source.subarray(0, MAX_LINE_BYTES).toString("utf8")} [line truncated]`;
};

/** Limits a rendered response by bytes so line-count controls cannot exhaust browser memory. */
export const boundedOutput = (lines, truncated) => {
  const output = [];
  let bytes = 0;
  for (const line of lines) {
    const next = `${line}\n`;
    const nextBytes = Buffer.byteLength(next);
    if (bytes + nextBytes > MAX_RESPONSE_BYTES) { truncated = true; break; }
    output.push(line);
    bytes += nextBytes;
  }
  if (truncated) output.push("[output truncated]");
  const text = output.join("\n");
  return { text, bytes: Buffer.byteLength(text), truncated };
};

/** Reads a bounded suffix, avoiding whole-file loads when locating a file tail. */
const readSuffix = async (handle, size, maximumBytes) => {
  const length = Math.min(size, maximumBytes);
  const buffer = Buffer.alloc(length);
  if (length) await handle.read(buffer, 0, length, size - length);
  return { text: buffer.toString("utf8"), truncated: size > length };
};

/** Resolves one cached source by ID so callers cannot choose a filesystem path. */
const resolveSource = (configuration, logId) => {
  const source = Array.isArray(configuration?.applicationLogs)
    ? configuration.applicationLogs.find((item) => Number(item.id) === Number(logId))
    : null;
  if (!source) throw new Error("Log source is not available in agent configuration.");
  return source;
};

/** Reads the configured number of trailing lines from a registered source. */
export const readRegisteredTail = async (configuration, hostRootPath, logId, requestedLimit) => {
  const source = resolveSource(configuration, logId);
  const limit = requestedLimit == null || requestedLimit === "" ? Number(source.tailLines) : Number(requestedLimit);
  if (!TAIL_LIMITS.has(limit)) throw new Error("Requested tail limit is invalid.");
  const { handle, stats } = await openRegisteredFile(hostRootPath, source.filePath);
  try {
    const suffix = await readSuffix(handle, stats.size, MAX_TAIL_SCAN_BYTES);
    const lines = suffix.text.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return boundedOutput(lines.slice(-limit).map(boundedLine), suffix.truncated);
  } finally { await handle.close(); }
};

/** Searches only the newest bounded file window and returns Bahotasu-style context blocks. */
export const searchRegisteredLog = async (configuration, hostRootPath, logId, query) => {
  if (typeof query !== "string" || !query || query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const source = resolveSource(configuration, logId);
  const { handle, stats } = await openRegisteredFile(hostRootPath, source.filePath);
  try {
    const suffix = await readSuffix(handle, stats.size, MAX_SEARCH_SCAN_BYTES);
    const lines = suffix.text.replace(/\r/g, "").split("\n");
    const matches = [];
    lines.forEach((line, index) => { if (line.includes(query)) matches.push(index); });
    const selected = matches.slice(-SEARCH_MATCH_LIMIT);
    const blocks = selected.map((matchIndex, occurrence) => {
      const start = Math.max(0, matchIndex - SEARCH_CONTEXT_LINES);
      const end = Math.min(lines.length, matchIndex + SEARCH_CONTEXT_LINES + 1);
      const context = lines.slice(start, end).map((line, index) => `${start + index === matchIndex ? ">" : " "} ${boundedLine(line)}`);
      return [`Occurrence ${occurrence + 1}/${selected.length}`, `Query: ${query}`, "----------------------------------------", ...context].join("\n");
    });
    return boundedOutput(blocks, suffix.truncated);
  } finally { await handle.close(); }
};

/** Reads trailing lines from a direct file path (for server/service/symbio logs, not application logs). */
export const readSystemLog = async (hostRootPath, filePath, requestedLimit) => {
  const limit = Number(requestedLimit) || 100;
  if (!TAIL_LIMITS.has(limit)) throw new Error("Requested tail limit is invalid.");
  const { handle, stats } = await openRegisteredFile(hostRootPath, filePath, true);
  try {
    const suffix = await readSuffix(handle, stats.size, MAX_TAIL_SCAN_BYTES);
    const lines = suffix.text.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return boundedOutput(lines.slice(-limit).map(boundedLine), suffix.truncated);
  } finally { await handle.close(); }
};

/** Searches a direct file path (for server/service/symbio logs, not application logs). */
export const searchSystemLog = async (hostRootPath, filePath, query) => {
  if (typeof query !== "string" || !query || query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const { handle, stats } = await openRegisteredFile(hostRootPath, filePath, true);
  try {
    const suffix = await readSuffix(handle, stats.size, MAX_SEARCH_SCAN_BYTES);
    const lines = suffix.text.replace(/\r/g, "").split("\n");
    const matches = [];
    lines.forEach((line, index) => { if (line.includes(query)) matches.push(index); });
    const selected = matches.slice(-SEARCH_MATCH_LIMIT);
    const blocks = selected.map((matchIndex, occurrence) => {
      const start = Math.max(0, matchIndex - SEARCH_CONTEXT_LINES);
      const end = Math.min(lines.length, matchIndex + SEARCH_CONTEXT_LINES + 1);
      const context = lines.slice(start, end).map((line, index) => `${start + index === matchIndex ? ">" : " "} ${boundedLine(line)}`);
      return [`Occurrence ${occurrence + 1}/${selected.length}`, `Query: ${query}`, "----------------------------------------", ...context].join("\n");
    });
    return boundedOutput(blocks, suffix.truncated);
  } finally { await handle.close(); }
};
