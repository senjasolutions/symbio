/**
 * Apache service component — probes via HTTP when a probe URL is configured,
 * and exposes an info endpoint that reads Apache config files to extract
 * installed modules and enabled virtual hosts.
 *
 * Write capabilities: enable/disable sites, write config files with validation
 * and rollback on config test failure.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const HOST_ROOT = "/host/root";
const MODS_ENABLED = "/etc/apache2/mods-enabled";
const SITES_ENABLED = "/etc/apache2/sites-enabled";
const SITES_AVAILABLE = "/etc/apache2/sites-available";

/** Runs a command via execFile and returns {status, stdout, stderr}. */
const runCommand = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
    resolve({
      status: error ? "failed" : "success",
      stdout: (stdout || "").slice(0, 5000),
      stderr: (stderr || "").slice(0, 2000),
      exitCode: error?.code || 0,
    });
  });
});

/** Runs apachectl -t and returns validation result. */
const validateApacheConfig = async () => {
  const result = await runCommand("apachectl", ["-t"]);
  return { valid: result.status === "success", output: result.stderr || result.stdout };
};

/** Reloads Apache via systemctl. */
const reloadApache = async () => runCommand("systemctl", ["reload", "apache2"]);

/** Lists directory entry names (files/symlinks) under the host root. */
const readHostDir = async (dirPath) => {
  try {
    const entries = await fs.readdir(path.join(HOST_ROOT, dirPath), { withFileTypes: true });
    return entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
};

/**
 * Reads a host file, returning null on error.
 */
const readHostFile = async (filePath) => {
  try {
    return await fs.readFile(path.join(HOST_ROOT, filePath), "utf8");
  } catch {
    return null;
  }
};

/**
 * Parses VirtualHost blocks from Apache config text.
 */
const parseVirtualHosts = (content, fileName) => {
  const hosts = [];
  const vhostRegex = /<VirtualHost\s+([^>]+)>([\s\S]*?)<\/VirtualHost>/gi;
  let match;
  while ((match = vhostRegex.exec(content)) !== null) {
    const addresses = match[1].trim();
    const body = match[2];
    let serverName = "";
    let documentRoot = "";
    let ssl = false;
    const aliases = [];
    const lines = body.split("\n");
    for (const line of lines) {
      const t = line.trim();
      const sn = t.match(/^ServerName\s+(\S+)/i);
      if (sn) serverName = sn[1];
      const dr = t.match(/^DocumentRoot\s+(\S+)/i);
      if (dr) documentRoot = dr[1];
      if (t.match(/^\s*SSLEngine\s+on/i)) ssl = true;
      const sa = t.match(/^ServerAlias\s+(.+)/i);
      if (sa) aliases.push(...sa[1].split(/\s+/));
    }
    hosts.push({
      file: fileName,
      addresses,
      serverName: serverName || "",
      documentRoot: documentRoot || "",
      ssl,
      aliases: aliases.join(", "),
    });
  }
  return hosts;
};

export default {
  type: "apache",
  displayName: "Apache",

  /**
   * Probes via HTTP when probeUrl is configured, or falls back to process detection.
   */
  async probe(service, { processDetected, result: makeResult }) {
    const detected = processDetected("apache");
    const configuration = service.configuration || {};
    if (!configuration.probeUrl) {
      return makeResult(service.id, detected ? "detected" : "not_detected", "process",
        detected
          ? "Apache process detected; configure an HTTP URL for liveness."
          : "Apache process was not detected.");
    }
    try {
      const response = await fetch(configuration.probeUrl, {
        redirect: "manual", signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      const status = response.status >= 500 ? "degraded" : "operational";
      return makeResult(service.id, status, "http", `HTTP ${response.status} from ${configuration.probeUrl}.`);
    } catch (error) {
      return makeResult(service.id, detected ? "unavailable" : "not_detected",
        detected ? "http" : "process",
        detected
          ? `Process detected but probe failed: ${error.message}`
          : `Service was not detected and probe failed: ${error.message}`);
    }
  },

  /**
   * Registers a bridge endpoint that returns Apache modules and virtual hosts info.
   */
  routes(router) {
    router.get("/api/v1/services/apache/info", async (c) => {
      try {
        const moduleFiles = await readHostDir(MODS_ENABLED);
        const modules = moduleFiles
          .filter((name) => name.endsWith(".load"))
          .map((name) => name.replace(/\.load$/i, ""));
        const sites = [];
        const siteFiles = await readHostDir(SITES_ENABLED);
        for (const sf of siteFiles) {
          const content = await readHostFile(path.join(SITES_ENABLED, sf));
          if (content) {
            const hosts = parseVirtualHosts(content, sf);
            sites.push(...hosts);
          }
        }
        return c.json({ ok: true, modules, sites });
      } catch (error) {
        return c.json({ ok: true, modules: [], sites: [], error: error.message });
      }
    });

    // ── Site management ──

    // Reads the content of a config file from sites-available or sites-enabled.
    router.get("/api/v1/services/apache/read-config", async (c) => {
      try {
        const fileName = c.req.query("file");
        if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0"))
          return c.json({ ok: false, error: "Invalid file name." }, 400);
        let content = await readHostFile(path.join(SITES_AVAILABLE, fileName));
        const source = content ? "sites-available" : null;
        if (!content) content = await readHostFile(path.join(SITES_ENABLED, fileName));
        if (content === null) return c.json({ ok: false, error: "Config file not found." }, 404);
        return c.json({ ok: true, file: fileName, source: source || "sites-enabled",
          content, bytes: Buffer.byteLength(content, "utf8") });
      } catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
      }
    });

    // Writes a config file to sites-available, validates, and optionally reloads.
    router.post("/api/v1/services/apache/write-config", async (c) => {
      try {
        const { file, content, reload } = await c.req.json();
        if (!file || file.includes("/") || file.includes("..") || file.includes("\0"))
          return c.json({ ok: false, error: "Invalid file name." }, 400);
        if (typeof content !== "string")
          return c.json({ ok: false, error: "Content must be a string." }, 400);
        if (Buffer.byteLength(content, "utf8") > 100 * 1024)
          return c.json({ ok: false, error: "Content exceeds 100 KB limit." }, 400);
        const prevContent = await readHostFile(path.join(SITES_AVAILABLE, file));
        const targetPath = path.join(HOST_ROOT, SITES_AVAILABLE, file);
        await fs.writeFile(targetPath, content, "utf8");
        const validation = await validateApacheConfig();
        if (!validation.valid) {
          if (prevContent !== null) await fs.writeFile(targetPath, prevContent, "utf8");
          else { try { await fs.unlink(targetPath); } catch {} }
          return c.json({ ok: false, error: `Apache config validation failed: ${validation.output}` }, 400);
        }
        if (reload) await reloadApache();
        return c.json({ ok: true, validated: true, reloaded: !!reload });
      } catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
      }
    });

    // Enables an Apache site using a2ensite, validates, and reloads.
    router.post("/api/v1/services/apache/enable-site", async (c) => {
      try {
        const { site } = await c.req.json();
        if (!site || site.includes("/") || site.includes("..") || site.includes("\0"))
          return c.json({ ok: false, error: "Invalid site name." }, 400);
        // Check source exists
        const availablePath = path.join(HOST_ROOT, SITES_AVAILABLE, site);
        try { await fs.access(availablePath, fsConstants.F_OK); }
        catch { return c.json({ ok: false, error: `Site config not found in ${SITES_AVAILABLE}.` }, 404); }
        // Run a2ensite
        const enableResult = await runCommand("a2ensite", [site]);
        if (enableResult.status === "failed")
          return c.json({ ok: false, error: `Failed to enable site: ${enableResult.stderr}` }, 400);
        // Validate (a2ensite has already created the symlink)
        const validation = await validateApacheConfig();
        if (!validation.valid) {
          // Rollback: run a2dissite
          await runCommand("a2dissite", [site]);
          return c.json({ ok: false, error: `Apache config validation failed after enabling site: ${validation.output}` }, 400);
        }
        await reloadApache();
        return c.json({ ok: true, validated: true, reloaded: true });
      } catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
      }
    });

    // Disables an Apache site using a2dissite, validates, and reloads.
    router.post("/api/v1/services/apache/disable-site", async (c) => {
      try {
        const { site } = await c.req.json();
        if (!site || site.includes("/") || site.includes("..") || site.includes("\0"))
          return c.json({ ok: false, error: "Invalid site name." }, 400);
        // Run a2dissite
        const disableResult = await runCommand("a2dissite", [site]);
        if (disableResult.status === "failed")
          return c.json({ ok: false, error: `Failed to disable site: ${disableResult.stderr}` }, 400);
        const validation = await validateApacheConfig();
        if (!validation.valid) {
          // Rollback: run a2ensite
          await runCommand("a2ensite", [site]);
          return c.json({ ok: false, error: `Apache config validation failed after disabling site: ${validation.output}` }, 400);
        }
        await reloadApache();
        return c.json({ ok: true, validated: true, reloaded: true });
      } catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
      }
    });
  },
};
