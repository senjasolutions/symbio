/**
 * Symbio self-log reader handles both mothership (direct file) and agent
 * (bridge) log sources so the dashboard can monitor its own health.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { config } from "../config.js";

const TAIL_LIMITS = new Set([50, 100, 200, 500, 1000]);
const MAX_TAIL_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 8 * 1024;

/** Reads the mothership's own log file from its persistent data volume. */
export const readMothershipLog = async (requestedLimit) => {
  const limit = Number(requestedLimit) || 100;
  if (!TAIL_LIMITS.has(limit)) throw new Error("Invalid tail limit.");
  const filePath = "/data/logs/mothership.log";
  let handle;
  try { handle = await fs.open(filePath, fsConstants.O_RDONLY); } catch {
    throw new Error("Mothership log file not found.");
  }
  const stats = await handle.stat();
  try {
    const size = Math.min(stats.size, MAX_TAIL_SCAN_BYTES);
    const buf = Buffer.alloc(size);
    if (size) await handle.read(buf, 0, size, stats.size - size);
    const text = buf.toString("utf8");
    const truncated = stats.size > size;
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const selected = lines.slice(-limit);
    const output = [];
    let bytes = 0;
    let outputTruncated = false;
    for (const line of selected) {
      const source = Buffer.from(line);
      const bounded = source.length <= MAX_LINE_BYTES ? line : `${source.subarray(0, MAX_LINE_BYTES).toString("utf8")} [line truncated]`;
      const next = `${bounded}\n`;
      const nextBytes = Buffer.byteLength(next);
      if (bytes + nextBytes > MAX_RESPONSE_BYTES) { outputTruncated = true; break; }
      output.push(bounded);
      bytes += nextBytes;
    }
    return { text: output.join("\n"), bytes, truncated: truncated || outputTruncated };
  } finally { await handle.close(); }
};

/** Searches the mothership log file for a query string. */
export const searchMothershipLog = async (query) => {
  if (typeof query !== "string" || !query || query.length > 500) throw new Error("Search query must contain 1–500 characters.");
  const filePath = "/data/logs/mothership.log";
  let handle;
  try { handle = await fs.open(filePath, fsConstants.O_RDONLY); } catch {
    throw new Error("Mothership log file not found.");
  }
  const stats = await handle.stat();
  try {
    const searchBytes = 8 * 1024 * 1024;
    const size = Math.min(stats.size, searchBytes);
    const buf = Buffer.alloc(size);
    if (size) await handle.read(buf, 0, size, stats.size - size);
    const text = buf.toString("utf8");
    const lines = text.replace(/\r/g, "").split("\n");
    const matches = [];
    lines.forEach((line, index) => { if (line.includes(query)) matches.push(index); });
    const SEARCH_MATCH_LIMIT = 5;
    const SEARCH_CONTEXT_LINES = 10;
    const selected = matches.slice(-SEARCH_MATCH_LIMIT);
    const blocks = selected.map((matchIndex, occurrence) => {
      const start = Math.max(0, matchIndex - SEARCH_CONTEXT_LINES);
      const end = Math.min(lines.length, matchIndex + SEARCH_CONTEXT_LINES + 1);
      const context = lines.slice(start, end).map((line, index) => `${start + index === matchIndex ? ">" : " "} ${line}`);
      return [`Occurrence ${occurrence + 1}/${selected.length}`, `Query: ${query}`, "----------------------------------------", ...context].join("\n");
    });
    const output = [];
    let bytes = 0;
    let truncated = stats.size > searchBytes;
    for (const block of blocks) {
      const next = `${block}\n\n`;
      const nextBytes = Buffer.byteLength(next);
      if (bytes + nextBytes > MAX_RESPONSE_BYTES) { truncated = true; break; }
      output.push(block);
      bytes += nextBytes;
    }
    return { text: output.join("\n\n"), bytes: Buffer.byteLength(output.join("\n\n")), truncated };
  } finally { await handle.close(); }
};

/** Calls the agent bridge to read the agent's own log file. */
const agentLogFetch = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`${config.agentBridgeUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${config.agentToken}`, "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error("Log agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Log agent request failed.");
  return payload;
};

export const readAgentLog = (limit) =>
  agentLogFetch(`/api/v1/symbio-logs/agent?limit=${encodeURIComponent(limit || 100)}`);

export const searchAgentLog = (query) =>
  agentLogFetch(`/api/v1/symbio-logs/agent/search`, { method: "POST", body: JSON.stringify({ query }) });
