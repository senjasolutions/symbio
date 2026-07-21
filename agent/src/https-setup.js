/**
 * HTTPS setup helpers — executes host commands via chroot for certbot/nginx operations.
 * The mothership is locked down, so the agent bridge delegates to the host root mount.
 *
 * Architecture: the agent has /:/host/root:rw, giving write access to the entire host.
 * Commands run via chroot /host/root so they see the host's actual filesystem.
 * nginx -t is mandatory before every reload.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";

const HOST_ROOT = "/host/root";
const CHROOT = "chroot";

/** Common nginx binary paths on Debian/Ubuntu systems. */
const NGINX_PATHS = ["/usr/sbin/nginx", "/usr/bin/nginx", "/usr/local/sbin/nginx", "/usr/local/bin/nginx"];

/**
 * Checks if a file exists and is executable on the host via the read-only mount.
 */
const hostAccess = async (filePath) => {
  try { await fs.access(path.join(HOST_ROOT, filePath), fs.constants.X_OK); return true; } catch { return false; }
};

/**
 * Host binary exists by checking common paths.
 */
export const checkNginx = async () => {
  for (const p of NGINX_PATHS) {
    if (await hostAccess(p)) return { installed: true };
  }
  return { installed: false };
};

/**
 * Check if certbot is on the host by checking the read-only mount.
 */
export const checkCertbot = async () => {
  const exists = await hostAccess("/usr/bin/certbot") || await hostAccess("/usr/local/bin/certbot");
  return { installed: exists };
};

/**
 * Fetches the server's public IPv4 address via host's curl (runs inside chroot).
 */
export const getServerIPv4 = async () => {
  try {
    // Use Node.js fetch instead — agent has host network anyway
    const response = await fetch("https://ipv4.icanhazip.com", { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const text = (await response.text()).trim();
      return { ip: text };
    }
    return { ip: null, error: "HTTP error" };
  } catch {
    return { ip: null, error: "Failed to fetch public IP" };
  }
};

/**
 * Resolves a domain to its IPv4 addresses using Node.js dns.
 */
export const checkDomain = async (domain) => {
  try {
    const addresses = await dns.resolve4(domain);
    return { resolves: addresses.length > 0, addresses };
  } catch {
    return { resolves: false, addresses: [] };
  }
};

/**
 * Returns full prerequisites check result.
 */
export const checkPrerequisites = async (domain) => {
  const [nginx, certbot, ipResult, dnsResult] = await Promise.all([
    checkNginx(),
    checkCertbot(),
    getServerIPv4(),
    domain ? checkDomain(domain) : Promise.resolve({ resolves: false, addresses: [] }),
  ]);
  return {
    nginxInstalled: nginx.installed,
    certbotInstalled: certbot.installed,
    serverIp: ipResult.ip,
    ipError: ipResult.error || null,
    domainResolves: dnsResult.resolves,
    resolvedAddresses: dnsResult.addresses,
  };
};

/**
 * Runs a bash script via chroot /host/root with domain ($1), port ($2), email ($3).
 * /host/root is writable, so the script can modify host files (nginx configs, certs).
 */
const runScriptViaChroot = (scriptContent, domain, port, email, timeout = 180000) => {
  return new Promise((resolve) => {
    const child = execFile(CHROOT, [HOST_ROOT, "bash", "-s", domain, port, email], {
      timeout,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        exitCode: error?.code || (error ? 1 : 0),
        error: error?.message || null,
      });
    });
    child.stdin.write(scriptContent);
    child.stdin.end();
  });
};

/**
 * Runs a host command via chroot, returning { stdout, stderr, exitCode }.
 */
const runHost = (cmd, args = [], timeout = 60000) => {
  return new Promise((resolve) => {
    const child = execFile(CHROOT, [HOST_ROOT, cmd, ...args], {
      timeout,
      maxBuffer: 128 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        exitCode: error?.code || (error ? 1 : 0),
        error: error?.message || null,
      });
    });
  });
};

/**
 * Executes the full HTTPS setup script via chroot.
 */
export const runSetup = async (domain, port, email, scriptContent) => {
  const result = await runScriptViaChroot(scriptContent, domain, port, email);
  return {
    ok: result.exitCode === 0,
    output: result.stdout || result.stderr,
    error: result.error,
    exitCode: result.exitCode,
  };
};

/**
 * Reads certificate info for a domain via openssl on the host.
 */
export const getCertInfo = async (domain) => {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  // Check cert file exists on host first
  let exists = false;
  try { await fs.access(path.join(HOST_ROOT, certPath), fs.constants.R_OK); exists = true; } catch {}
  if (!exists) return { enabled: false };

  const [infoResult, timerCheckResult] = await Promise.all([
    runHost("openssl", ["x509", "-in", certPath, "-noout", "-issuer", "-dates", "-dateopt", "iso_8601"], 15000),
    // systemctl uses D-Bus which isn't available inside chroot; check timer file exists instead
    runHost("test", ["-f", "/etc/systemd/system/multi-user.target.wants/certbot.timer"], 5000),
  ]);

  const parseDate = (label, text) => {
    if (!text) return null;
    const match = text.split("\n").find((l) => l.startsWith(label));
    if (!match) return null;
    const dateStr = match.replace(/^not(Before|After)=/i, "").trim();
    const date = new Date(dateStr);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };

  let issuer = null;
  let issued = null;
  let expires = null;
  if (infoResult.exitCode === 0) {
    const out = infoResult.stdout;
    const lines = out.split("\n");
    issuer = lines.find((l) => l.startsWith("issuer="))?.replace(/^issuer=\s*/i, "").trim() || null;
    issued = parseDate("notBefore", out);
    expires = parseDate("notAfter", out);
  }

  // certbot apt package auto-installs the systemd timer; check the unit symlink exists
  const autoRenewActive = timerCheckResult.exitCode === 0;

  return {
    enabled: true,
    domain,
    issuer: issuer || "Unknown",
    issuedAt: issued,
    expiresAt: expires,
    autoRenewActive,
  };
};

/**
 * Manually triggers certbot renewal on the host via chroot.
 */
export const renewCert = async () => {
  const result = await runHost("certbot", ["renew", "--nginx", "--non-interactive"], 120000);
  return {
    ok: result.exitCode === 0,
    output: result.stdout || result.stderr,
    renewed: result.stdout?.includes("success") || result.stdout?.includes("Certificate") || false,
    error: result.error,
  };
};
