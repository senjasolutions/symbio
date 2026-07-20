/**
 * Mothership-to-agent file-manager client preserves the browser boundary:
 * validated paths cross the bridge through bounded, read-only operations
 * without exposing the host filesystem or accepting raw browser input.
 */

import { config } from "../config.js";

/** Calls the bridge-only agent API and normalizes its truthful error payloads. */
const agentFileFetch = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`${config.agentBridgeUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${config.agentToken}`, "content-type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("File manager agent is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "File manager request failed.");
  return payload;
};

/** Lists one directory with optional hidden-file visibility. */
export const listDirectory = (dirPath, showHidden) =>
  agentFileFetch(`/api/v1/files/list?path=${encodeURIComponent(dirPath)}${showHidden ? "&showHidden=1" : ""}`);

/** Reads a bounded portion of a regular file for inline preview. */
export const readFile = (filePath, maxBytes) =>
  agentFileFetch(`/api/v1/files/read?path=${encodeURIComponent(filePath)}${maxBytes ? `&maxBytes=${encodeURIComponent(maxBytes)}` : ""}`);

/** Returns one level of subdirectories for the lazy-loading tree widget. */
export const getDirectoryTree = (dirPath) =>
  agentFileFetch(`/api/v1/files/tree?path=${encodeURIComponent(dirPath)}`);

/** Reads a file for the dedicated viewer (100 KB cap, text only). */
export const viewFile = (filePath) =>
  agentFileFetch(`/api/v1/files/view?path=${encodeURIComponent(filePath)}`);

// ── Write operations ──

/** Creates a new file or directory at the given path. */
export const createEntry = (dirPath, name, type) =>
  agentFileFetch("/api/v1/files/create", { method: "POST", body: JSON.stringify({ dirPath, name, type }) });

/** Writes UTF-8 content to a file (100 KB max). */
export const writeFile = (filePath, content) =>
  agentFileFetch("/api/v1/files/write", { method: "POST", body: JSON.stringify({ path: filePath, content }) });

/** Deletes a file or directory at the given path. */
export const deleteEntry = (filePath) =>
  agentFileFetch("/api/v1/files/delete", { method: "POST", body: JSON.stringify({ path: filePath }) });

/** Renames or moves a file/directory from `from` to `to`. */
export const renameEntry = (fromPath, toPath) =>
  agentFileFetch("/api/v1/files/rename", { method: "POST", body: JSON.stringify({ from: fromPath, to: toPath }) });

/** Changes file/directory permissions (chmod). Mode is an octal string like "644". */
export const changeMode = (filePath, mode) =>
  agentFileFetch("/api/v1/files/chmod", { method: "POST", body: JSON.stringify({ path: filePath, mode }) });
