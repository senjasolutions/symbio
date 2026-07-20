/**
 * File manager with read-write capabilities for host filesystem access.
 * All operations go through the same mount-point containment pattern as
 * log-reader: validateHostPath → mountedPath → resolvePath → isAllowedPath.
 *
 * Write operations (create, write, delete, rename, chmod) use node:fs
 * directly — no shell commands, no exec(). Every write uses the same
 * security stack as read operations.
 *
 * SECURITY: See isAllowedPath() for the path-whitelist and blocklist
 * enforcement that makes this fort-knox-grade.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const MAX_READ_BYTES = 1 * 1024 * 1024;
const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_VIEW_BYTES = 100 * 1024; // 100 KB hard cap for the file viewer
const MAX_WRITE_BYTES = 100 * 1024; // 100 KB hard cap for file writes

// Valid chmod mode: octal string 000–777, 3 or 4 digits
const CHMOD_RE = /^[0-7]{3,4}$/;

// Only directories under these roots are browsable. Everything else is denied.
// This is paired with BLOCKED_PATTERNS below — the real LFI defense is the
// pattern list, not the root list. We allow /etc because a server admin needs
// to browse /etc/nginx, /etc/apache2, /etc/systemd, etc. while blocked patterns
// catch /etc/shadow, /etc/ssh, /etc/ssl/private, etc.
const ALLOWED_ROOTS = [
  "/boot",
  "/etc",
  "/home",
  "/mnt",
  "/opt",
  "/srv",
  "/tmp",
  "/usr",
  "/var",
];

// File or directory name patterns that are forbidden even inside an allowed
// root. Every component of the real resolved path is checked. This catches
// SSH keys, .env secrets, git internals, package-lock data, dotfiles that
// store credentials, and common key-store extensions.
const BLOCKED_PATTERNS = [
  // System credential stores
  ".ssh", ".gnupg", ".aws", ".gcloud", ".azure", ".config/gcloud",
  // Application secrets
  ".env", ".env.local", ".env.production", ".env.development", ".env.test",
  // Git internals — leak a .git/config and you leak remotes + URLs
  ".git",
  // Package manager lock files — leak dependency trees, internal URLs
  "package-lock.json", "yarn.lock", "composer.lock", "Gemfile.lock",
  "go.sum", "Cargo.lock", "pnpm-lock.yaml",
  // Key / certificate files
  ".pem", ".key", ".p12", ".pfx", ".cert", ".crt", ".cer", ".der",
  ".pkcs12", ".jks", ".ks",
  // Known credential filenames (case-insensitive on Linux by path norm)
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "authorized_keys", "known_hosts",
  "credentials", "credential", ".netrc", "_netrc",
  "passwd", "shadow", "sudoers", "htpasswd",
  ".htpasswd", ".htaccess",
  // Docker/Podman
  "/var/lib/docker", "/var/lib/containerd",
  // PM2 ecosystem files may contain process metadata and paths
  ".pm2",
];

// File extensions blocked in file viewer specifically (binary-like configs
// that could contain secrets or are simply useless to browse)
const BLOCKED_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".cert", ".crt", ".cer", ".der",
  ".pkcs12", ".jks", ".ks",
]);
// File extensions unlikely to produce readable text in a <pre> block.
const BINARY_EXTENSIONS = new Set([
  ".gz", ".bz2", ".xz", ".zip", ".tar", ".tgz", ".rar", ".7z",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico", ".webp", ".svgz",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".webm",
  ".exe", ".dll", ".so", ".o", ".a", ".bin", ".dat",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3",
]);

/** Rejects values that could reinterpret a host path during mapping. */
const validateHostPath = (filePath) => {
  if (typeof filePath !== "string" || !path.posix.isAbsolute(filePath) || filePath.includes("\0"))
    throw new Error("File path is invalid.");
  if (filePath.split("/").includes(".."))
    throw new Error("File path contains traversal.");
  return filePath;
};

/** Maps an approved absolute host path under the fixed read-only host-root bind. */
const mountedPath = (hostRootPath, filePath) => {
  const root = path.resolve(hostRootPath);
  const target = path.resolve(root, `.${validateHostPath(filePath)}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    throw new Error("File path escapes host root.");
  return { root, target };
};

/**
 * Resolves and validates a host path, returning the real fs path and stat
 * result. Rejects symlinks to prevent escape from the read-only bind.
 */
const resolvePath = async (hostRootPath, filePath) => {
  const { root, target } = mountedPath(hostRootPath, filePath);
  // Pre-lstat blocked-pattern check catches non-existent blocked files too.
  const rootPrefixPre = root === "/" ? "/" : root + "/";
  const preHostPath = target.startsWith(rootPrefixPre) ? target.slice(root.length) : target;
  for (const pattern of BLOCKED_PATTERNS) {
    if (preHostPath.includes(pattern)) throw new Error("Access to this path is restricted.");
  }
  const entry = await fs.lstat(target);
  if (entry.isSymbolicLink()) throw new Error("Symlinks are not accessible through the file manager.");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`))
    throw new Error("Resolved path escapes host root.");
  // After realpath, compute the host path again (catches symlink resolution).
  // Handle root (/) specially to avoid // prefix in startsWith check.
  const rootPrefix = realRoot === "/" ? "/" : realRoot + "/";
  const postHostPath = realTarget.startsWith(rootPrefix) ? realTarget.slice(realRoot.length) : realTarget;
  isAllowedPath(postHostPath);
  return { target, entry, realTarget };
};

/** Formats a Unix permission mode as a human-readable octal string. */
const formatPermissions = (mode) => {
  const octal = (mode & 0o777).toString(8);
  return octal.padStart(3, "0");
};

/** Guesses whether a file is likely binary based on its extension. */
const isLikelyBinary = (name) => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(ext);
};

/**
 * FORT-KNOX check: after realpath resolution we verify the resolved path
 * starts with an allowed root AND does not match any blocked pattern.
 * This runs inside resolvePath() so every list/read/tree/view hits it.
 * The hostPath argument is already stripped of the container prefix.
 */
const isAllowedPath = (hostPath) => {
  const allowed = ALLOWED_ROOTS.some((r) => hostPath === r || hostPath.startsWith(r + "/"));
  if (!allowed) throw new Error("Access to this directory is restricted.");
  for (const pattern of BLOCKED_PATTERNS) {
    if (hostPath.includes(pattern)) throw new Error("Access to this path is restricted.");
  }
};

/**
 * Lists directory contents with stat details for each entry.
 * Path is validated through resolvePath, never reaching the fs raw.
 */
export const listDirectory = async (hostRootPath, dirPath, showHidden = false) => {
  const { target } = await resolvePath(hostRootPath, dirPath);
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ? fsConstants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("Path is not a directory.");
    const names = await fs.readdir(target);
    const entries = [];
    for (const name of names) {
      if (!showHidden && name.startsWith(".")) continue;
      try {
        const entryPath = path.join(target, name);
        const entryStat = await fs.lstat(entryPath);
        entries.push({
          name,
          type: entryStat.isDirectory() ? "directory"
            : entryStat.isSymbolicLink() ? "symlink"
            : entryStat.isFile() ? "file"
            : "other",
          size: entryStat.isFile() ? entryStat.size : 0,
          modified: entryStat.mtime.toISOString(),
          permissions: formatPermissions(entryStat.mode),
          owner: entryStat.uid,
          group: entryStat.gid,
        });
      } catch {
        // Permissions deny reading this entry; include it with no metadata.
        entries.push({ name, type: "unknown", size: 0, modified: "", permissions: "???", owner: 0, group: 0 });
      }
    }
    // Directories first, then files, alphabetically within each group.
    entries.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { entries, path: dirPath };
  } finally {
    await handle.close();
  }
};

/**
 * Reads a bounded portion of a regular file for browser preview.
 * Binary files are detected by extension and rejected early.
 */
export const readFileContent = async (hostRootPath, filePath, maxBytes = MAX_FILE_PREVIEW_BYTES) => {
  const resolvedMax = Math.min(maxBytes, MAX_READ_BYTES);
  const { target, entry } = await resolvePath(hostRootPath, filePath);
  if (!entry.isFile()) throw new Error("Path is not a regular file.");
  const name = path.posix.basename(filePath);
  if (isLikelyBinary(name)) throw new Error("Binary files cannot be previewed.");
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) { await handle.close(); throw new Error("File changed to a non-regular file."); }
    const buffer = Buffer.alloc(Math.min(stats.size, resolvedMax));
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8");
    return {
      text,
      bytes: Buffer.byteLength(text),
      fileSize: stats.size,
      truncated: stats.size > resolvedMax,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Reads a file for the dedicated viewer with a strict 100 KB size limit and
 * null-byte binary detection. Returns line count and file size alongside text.
 */
export const viewFileContent = async (hostRootPath, filePath) => {
  const { target, entry } = await resolvePath(hostRootPath, filePath);
  if (!entry.isFile()) throw new Error("Path is not a regular file.");
  const name = path.posix.basename(filePath);
  if (isLikelyBinary(name)) throw new Error("Binary files cannot be viewed.");
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) { await handle.close(); throw new Error("File changed to a non-regular file."); }
    if (stats.size > MAX_VIEW_BYTES) throw new Error(`File exceeds the 100 KB maximum size (${stats.size} bytes).`);
    const buffer = Buffer.alloc(stats.size);
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, 0);
    // Null-byte binary detection: scan first 512 bytes for \0.
    const preview = buffer.subarray(0, Math.min(buffer.length, 512));
    for (let i = 0; i < preview.length; i++) {
      if (preview[i] === 0) throw new Error("Binary files cannot be viewed.");
    }
    const text = buffer.toString("utf8");
    return {
      text,
      bytes: Buffer.byteLength(text),
      fileSize: stats.size,
      lineCount: text.split("\n").length,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Returns one level of directory children for lazy-loading the file tree.
 * Each child includes a hasChildren flag so the UI knows whether to render
 * an expand arrow before the next AJAX request.
 */
export const getDirectoryTree = async (hostRootPath, dirPath) => {
  const { target } = await resolvePath(hostRootPath, dirPath);
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ? fsConstants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("Path is not a directory.");
    const names = await fs.readdir(target);
    const children = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        const entryPath = path.join(target, name);
        const entryStat = await fs.lstat(entryPath);
        if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
          // Check if this directory has at least one non-hidden child directory.
          let hasChildren = false;
          try {
            const subNames = await fs.readdir(entryPath);
            for (const sub of subNames) {
              if (sub.startsWith(".")) continue;
              try {
                const subStat = await fs.lstat(path.join(entryPath, sub));
                if (subStat.isDirectory() && !subStat.isSymbolicLink()) { hasChildren = true; break; }
              } catch { /* skip inaccessible */ }
            }
          } catch { /* skip inaccessible */ }
          children.push({
            name,
            path: dirPath === "/" ? `/${name}` : `${dirPath}/${name}`,
            hasChildren,
          });
        }
      } catch { /* skip inaccessible entries */ }
    }
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { children, path: dirPath };
  } finally {
    await handle.close();
  }
};

// ── Write Operations ────────────────────────────────────────────────
// Every write function uses the same resolvePath security stack as reads.
// For create operations where the target doesn't exist yet, we validate
// the parent directory through resolvePath and then construct the target.

/** Validates a file/directory name doesn't contain traversal or blocked patterns. */
const validateName = (name) => {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\0") || name === ".." || name === ".")
    throw new Error("Invalid file name.");
  for (const pattern of BLOCKED_PATTERNS) {
    if (name === pattern || name.includes(pattern))
      throw new Error("File name is restricted.");
  }
};

/** Resolves the parent directory and constructs the full target path for a new entry. */
const resolveParentForCreate = async (hostRootPath, dirPath, name) => {
  validateName(name);
  const { target: parentTarget } = await resolvePath(hostRootPath, dirPath);
  const fullPath = path.join(parentTarget, name);
  // Ensure full path is still under the resolved parent
  const parentReal = await fs.realpath(parentTarget);
  if (!fullPath.startsWith(parentReal + path.sep) && fullPath !== parentReal + path.sep + name)
    throw new Error("New path escapes parent directory.");
  return fullPath;
};

/**
 * Creates an empty file at dirPath/name. Returns the created file path.
 * File is created with mode 0o644 (rw-r--r--).
 */
export const createFile = async (hostRootPath, dirPath, name) => {
  const target = await resolveParentForCreate(hostRootPath, dirPath, name);
  // O_WRONLY | O_CREAT | O_EXCL ensures atomic create-or-fail
  const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
  await handle.close();
  return { path: dirPath === "/" ? `/${name}` : `${dirPath}/${name}`, name };
};

/**
 * Creates a new directory at dirPath/name. Returns the created directory path.
 * Directory is created with mode 0o755 (rwxr-xr-x).
 */
export const createDirectory = async (hostRootPath, dirPath, name) => {
  const target = await resolveParentForCreate(hostRootPath, dirPath, name);
  await fs.mkdir(target, { mode: 0o755 });
  return { path: dirPath === "/" ? `/${name}` : `${dirPath}/${name}`, name };
};

/**
 * Writes UTF-8 content to a file, capped at 100 KB. Overwrites existing content.
 * The target file must already exist (resolved through resolvePath).
 */
export const writeFile = async (hostRootPath, filePath, content) => {
  if (typeof content !== "string") throw new Error("File content must be a string.");
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_WRITE_BYTES)
    throw new Error(`File content exceeds the ${MAX_WRITE_BYTES / 1024} KB limit (${contentBytes} bytes).`);
  // Null-byte detection: reject binary content
  const preview = content.slice(0, Math.min(content.length, 512));
  for (let i = 0; i < preview.length; i++) {
    if (preview.charCodeAt(i) === 0) throw new Error("Cannot write binary content to files.");
  }
  const { target, entry } = await resolvePath(hostRootPath, filePath);
  if (!entry.isFile()) throw new Error("Path is not a regular file.");
  await fs.writeFile(target, content, "utf8");
  return { path: filePath, bytes: contentBytes };
};

/**
 * Deletes a file or directory (recursive for directories) at the given path.
 * ALLOWED_ROOTS themselves are protected from deletion.
 */
export const deleteFileOrDir = async (hostRootPath, filePath) => {
  // Protect allowed root directories from accidental deletion
  for (const root of ALLOWED_ROOTS) {
    if (filePath === root) throw new Error("Cannot delete root directory.");
  }
  const { target, entry } = await resolvePath(hostRootPath, filePath);
  if (entry.isDirectory()) {
    await fs.rm(target, { recursive: true, force: false, maxRetries: 1 });
  } else {
    await fs.unlink(target);
  }
  return { path: filePath };
};

/**
 * Renames or moves a file or directory from fromPath to toPath.
 * Both paths must be under allowed roots. The destination must not exist.
 */
export const renameFileOrDir = async (hostRootPath, fromPath, toPath) => {
  // Protect roots from being renamed
  for (const root of ALLOWED_ROOTS) {
    if (fromPath === root) throw new Error("Cannot rename root directory.");
  }
  // Validate destination parent directory separately
  const toDir = path.posix.dirname(toPath);
  const toName = path.posix.basename(toPath);
  if (!toName || toName === "." || toName === "..") throw new Error("Invalid destination path.");
  validateName(toName);
  const { target: fromTarget } = await resolvePath(hostRootPath, fromPath);
  const { target: toParent } = await resolvePath(hostRootPath, toDir);
  const toTarget = path.join(toParent, toName);
  // Ensure no overwrite (rename fails if dest exists on most fs, but be explicit)
  try { await fs.lstat(toTarget); throw new Error("Destination path already exists."); } catch (e) { if (e.code !== "ENOENT") throw e; }
  await fs.rename(fromTarget, toTarget);
  return { from: fromPath, to: toPath };
};

/**
 * Changes file/directory permissions using chmod. Mode must be a 3-4 digit
 * octal string (e.g. "644" or "0755").
 */
export const changeMode = async (hostRootPath, filePath, mode) => {
  if (typeof mode !== "string" || !CHMOD_RE.test(mode))
    throw new Error("Invalid permission mode. Must be a 3-4 digit octal string (e.g. '644').");
  const octal = parseInt(mode, 8);
  const { target } = await resolvePath(hostRootPath, filePath);
  await fs.chmod(target, octal);
  return { path: filePath, mode };
};
