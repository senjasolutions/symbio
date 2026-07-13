/**
 * Apache service component — probes via HTTP when a probe URL is configured,
 * and exposes an info endpoint that reads Apache config files to extract
 * installed modules and enabled virtual hosts.
 */

import fs from "node:fs/promises";
import path from "node:path";

const HOST_ROOT = "/host/root";
const MODS_ENABLED = "/etc/apache2/mods-enabled";
const SITES_ENABLED = "/etc/apache2/sites-enabled";

/**
 * Lists directory entry names (files/symlinks) under the host root.
 */
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
  },
};
