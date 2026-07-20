/**
 * Nginx service component — probes via HTTP when a probe URL is configured,
 * and exposes an info endpoint that reads nginx config files to extract
 * installed modules and enabled sites with their server names and SSL status.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const HOST_ROOT = "/host/root";
const NGINX_CONF = "/etc/nginx/nginx.conf";
const SITES_ENABLED = "/etc/nginx/sites-enabled";
const SITES_AVAILABLE = "/etc/nginx/sites-available";
const MODULES_ENABLED = "/etc/nginx/modules-enabled";

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

/** Runs nginx -t and returns validation result. */
const validateNginxConfig = async () => {
  const result = await runCommand("nginx", ["-t"]);
  return { valid: result.status === "success", output: result.stderr || result.stdout };
};

/** Reloads nginx without dropping connections. */
const reloadNginx = async () => runCommand("nginx", ["-s", "reload"]);

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

     // ── Site management ──
     // Reads the content of a config file from sites-available or sites-enabled.
     router.get("/api/v1/services/nginx/read-config", async (c) => {
       try {
         const fileName = c.req.query("file");
         if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0"))
           return c.json({ ok: false, error: "Invalid file name." }, 400);
         // Check sites-available first (source), then sites-enabled
         let content = await readHostFile(path.join(SITES_AVAILABLE, fileName));
         const source = content ? "sites-available" : null;
         if (!content) {
           content = await readHostFile(path.join(SITES_ENABLED, fileName));
         }
         if (content === null) return c.json({ ok: false, error: "Config file not found." }, 404);
         return c.json({ ok: true, file: fileName, source: source || "sites-enabled", content,
           bytes: Buffer.byteLength(content, "utf8") });
       } catch (error) {
         return c.json({ ok: false, error: error.message }, 400);
       }
     });

     // Writes a config file to sites-available, validates, and optionally reloads.
     router.post("/api/v1/services/nginx/write-config", async (c) => {
       try {
         const { file, content, reload } = await c.req.json();
         if (!file || file.includes("/") || file.includes("..") || file.includes("\0"))
           return c.json({ ok: false, error: "Invalid file name." }, 400);
         if (typeof content !== "string")
           return c.json({ ok: false, error: "Content must be a string." }, 400);
         if (Buffer.byteLength(content, "utf8") > 100 * 1024)
           return c.json({ ok: false, error: "Content exceeds 100 KB limit." }, 400);
         // Read previous content for rollback
         const prevContent = await readHostFile(path.join(SITES_AVAILABLE, file));
         const targetPath = path.join(HOST_ROOT, SITES_AVAILABLE, file);
         await fs.writeFile(targetPath, content, "utf8");
         // Validate
         const validation = await validateNginxConfig();
         if (!validation.valid) {
           // Rollback
           if (prevContent !== null) await fs.writeFile(targetPath, prevContent, "utf8");
           else {
             try { await fs.unlink(targetPath); } catch {}
           }
           return c.json({ ok: false, error: `Nginx config validation failed: ${validation.output}` }, 400);
         }
         // Reload if requested
         if (reload) await reloadNginx();
         return c.json({ ok: true, validated: true, reloaded: !!reload });
       } catch (error) {
         return c.json({ ok: false, error: error.message }, 400);
       }
     });

     // Enables a site by symlinking from sites-available to sites-enabled.
     router.post("/api/v1/services/nginx/enable-site", async (c) => {
       try {
         const { site } = await c.req.json();
         if (!site || site.includes("/") || site.includes("..") || site.includes("\0"))
           return c.json({ ok: false, error: "Invalid site name." }, 400);
         const availablePath = path.join(HOST_ROOT, SITES_AVAILABLE, site);
         const enabledPath = path.join(HOST_ROOT, SITES_ENABLED, site);
         // Check source exists
         try { await fs.access(availablePath, fsConstants.F_OK); }
         catch { return c.json({ ok: false, error: `Site config not found in ${SITES_AVAILABLE}.` }, 404); }
         // Check not already enabled
         try { await fs.access(enabledPath, fsConstants.F_OK); return c.json({ ok: false, error: "Site is already enabled." }, 400); }
         catch { /* expected */ }
         // Create relative symlink
         await fs.symlink(path.join("..", "sites-available", site), enabledPath);
         // Validate
         const validation = await validateNginxConfig();
         if (!validation.valid) {
           // Rollback
           try { await fs.unlink(enabledPath); } catch {}
           return c.json({ ok: false, error: `Nginx config validation failed after enabling site: ${validation.output}` }, 400);
         }
         // Reload
         await reloadNginx();
         return c.json({ ok: true, validated: true, reloaded: true });
       } catch (error) {
         return c.json({ ok: false, error: error.message }, 400);
       }
     });

     // Disables a site by removing the symlink from sites-enabled.
     router.post("/api/v1/services/nginx/disable-site", async (c) => {
       try {
         const { site } = await c.req.json();
         if (!site || site.includes("/") || site.includes("..") || site.includes("\0"))
           return c.json({ ok: false, error: "Invalid site name." }, 400);
         const enabledPath = path.join(HOST_ROOT, SITES_ENABLED, site);
         // Check it exists
         try { await fs.access(enabledPath, fsConstants.F_OK); }
         catch { return c.json({ ok: false, error: "Site is not enabled." }, 404); }
         // Remove symlink
         await fs.unlink(enabledPath);
         // Validate
         const validation = await validateNginxConfig();
         if (!validation.valid) {
           return c.json({ ok: false, error: `Nginx config validation failed after disabling site: ${validation.output}. The site symlink has been removed; fix remaining config issues manually.` }, 400);
         }
         // Reload
         await reloadNginx();
         return c.json({ ok: true, validated: true, reloaded: true });
       } catch (error) {
         return c.json({ ok: false, error: error.message }, 400);
       }
     });
  },
};
