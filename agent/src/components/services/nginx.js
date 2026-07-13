/**
 * Nginx service component — probes via HTTP when a probe URL is configured,
 * and exposes an info endpoint that reads nginx config files to extract
 * installed modules and enabled sites with their server names and SSL status.
 */

import fs from "node:fs/promises";
import path from "node:path";

const HOST_ROOT = "/host/root";
const NGINX_CONF = "/etc/nginx/nginx.conf";
const SITES_ENABLED = "/etc/nginx/sites-enabled";
const MODULES_ENABLED = "/etc/nginx/modules-enabled";

/**
 * Reads a text file under the host root, returning null on any error.
 */
const readHostFile = async (filePath) => {
  try {
    return await fs.readFile(path.join(HOST_ROOT, filePath), "utf8");
  } catch {
    return null;
  }
};

/**
 * Lists directory entries (names only) under the host root, returning empty array on error.
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
 * Extracts load_module directives from nginx.conf — each directive names a
 * dynamic module .so file.
 */
const extractModules = (content) => {
  const modules = [];
  const regex = /load_module\s+modules\/([^;]+);/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    modules.push(match[1].replace(/\.so$/, ""));
  }
  return modules;
};

/**
 * Parses server blocks from an nginx config fragment. Returns an array of
 * { serverNames, listen, ssl, root, proxyPass } objects.
 */
const parseServerBlocks = (content, fileName) => {
  const blocks = [];
  // Split by server { ... } blocks using a simple brace-depth parser
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") {
      if (depth === 0 && content.slice(Math.max(0, i - 10), i).trim().endsWith("server")) {
        start = i + 1;
      }
      depth++;
    } else if (content[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const block = content.slice(start, i);
        const serverNames = [];
        const listens = [];
        let ssl = false;
        let root = "";
        let proxyPass = "";
        for (const line of block.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("server_name")) {
            const names = trimmed.replace(/server_name\s+/, "").replace(/;$/, "").split(/\s+/);
            for (const n of names) {
              if (n && !n.startsWith("$")) serverNames.push(n);
            }
          }
          const listenMatch = trimmed.match(/listen\s+(\S+)/);
          if (listenMatch) listens.push(listenMatch[1]);
          if (trimmed.includes("ssl") && (trimmed.startsWith("ssl_certificate") || trimmed.startsWith("listen") && trimmed.includes("ssl"))) {
            ssl = true;
          }
          const rootMatch = trimmed.match(/root\s+(\S+);/);
          if (rootMatch) root = rootMatch[1];
          const proxyMatch = trimmed.match(/proxy_pass\s+(\S+);/);
          if (proxyMatch) proxyPass = proxyMatch[1];
        }
        blocks.push({
          file: fileName,
          serverNames: serverNames.join(", "),
          listen: listens.join(", ") || "80",
          ssl,
          root: root || "",
          proxyPass: proxyPass || "",
        });
        start = -1;
      }
    }
  }
  return blocks;
};

export default {
  type: "nginx",
  displayName: "Nginx",

  /**
   * Probes via HTTP when probeUrl is configured, or falls back to process detection.
   */
  async probe(service, { processDetected, result: makeResult }) {
    const detected = processDetected("nginx");
    const configuration = service.configuration || {};
    if (!configuration.probeUrl) {
      return makeResult(service.id, detected ? "detected" : "not_detected", "process",
        detected
          ? "Nginx process detected; configure an HTTP URL for liveness."
          : "Nginx process was not detected.");
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
   * Registers a bridge endpoint that returns nginx modules and sites information.
   */
  routes(router) {
    router.get("/api/v1/services/nginx/info", async (c) => {
      try {
        const mainConfig = await readHostFile(NGINX_CONF);
        const modules = mainConfig ? extractModules(mainConfig) : [];
        // Also list modules-enabled directory
        const moduleFiles = await readHostDir(MODULES_ENABLED);
        for (const mf of moduleFiles) {
          const bare = mf.replace(/\.conf$/i, "");
          if (!modules.includes(bare)) modules.push(bare);
        }
        // Parse sites
        const sites = [];
        const siteFiles = await readHostDir(SITES_ENABLED);
        for (const sf of siteFiles) {
          const content = await readHostFile(path.join(SITES_ENABLED, sf));
          if (content) {
            const blocks = parseServerBlocks(content, sf);
            sites.push(...blocks);
          }
        }
        return c.json({ ok: true, modules, sites });
      } catch (error) {
        return c.json({ ok: true, modules: [], sites: [], error: error.message });
      }
    });
  },
};
