const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.SYMBIO_DATA_DIR || "/data";
const publicDir = path.join(__dirname, "public");
const configPath = path.join(dataDir, "onboarding.json");
const healthTimeoutMs = Number(process.env.SYMBIO_HEALTH_TIMEOUT_MS || 10_000);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validAutomationLevel(value) {
  const allowed = new Set([
    "observe",
    "safe-recovery",
    "guided-repair",
    "trusted-auto-repair",
    "full-autopilot",
  ]);
  return allowed.has(value) ? value : "guided-repair";
}

function normalizeSiteUrl(value) {
  const raw = safeText(value, 240);
  if (!raw) return "";

  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Site URL must use http or https");
  }

  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

function parseHealthPaths(value) {
  const rawItems = Array.isArray(value)
    ? value
    : safeText(value, 4_000)
        .split(/[\n,]/)
        .map((item) => item.trim());

  const seen = new Set();
  const paths = [];

  for (const item of rawItems) {
    const text = safeText(item, 240);
    if (!text) continue;

    const pathOnly = text.startsWith("http://") || text.startsWith("https://")
      ? new URL(text).pathname + new URL(text).search
      : text;
    const normalized = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);

    if (paths.length >= 20) break;
  }

  return paths.length ? paths : ["/"];
}

function buildTargetUrl(baseUrl, healthPath) {
  const base = new URL(baseUrl);
  const target = new URL(healthPath, base);

  if (target.origin !== base.origin) {
    throw new Error(`Health path must stay on ${base.origin}`);
  }

  target.hash = "";
  return target.toString();
}

async function readConfig() {
  const file = await fs.readFile(configPath, "utf8");
  return JSON.parse(file);
}

async function checkPage(baseUrl, healthPath) {
  const url = buildTargetUrl(baseUrl, healthPath);
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Symbio-Agent/0.1 read-only-health-check",
        accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
      },
    });

    await response.body?.cancel();

    return {
      path: healthPath,
      url,
      finalUrl: response.url,
      ok: response.status >= 200 && response.status < 400,
      statusCode: response.status,
      responseMs: Math.round(performance.now() - startedAt),
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    return {
      path: healthPath,
      url,
      ok: false,
      statusCode: null,
      responseMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "Health check failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleStatus(response) {
  let configured = false;
  let config = null;

  try {
    config = await readConfig();
    configured = true;
  } catch {
    configured = false;
  }

  sendJson(response, 200, {
    service: "symbio-agent",
    status: "ok",
    configured,
    config,
  });
}

async function handleOnboarding(request, response) {
  try {
    const rawBody = await readRequestBody(request);
    const input = JSON.parse(rawBody || "{}");
    const now = new Date().toISOString();
    const openRouterKey = safeText(input.openRouterKey, 512);
    const siteUrl = normalizeSiteUrl(input.siteUrl);

    const config = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      mode: safeText(input.mode, 64) || "self-hosted-solo",
      siteName: safeText(input.siteName, 120),
      siteUrl,
      ownerEmail: safeText(input.ownerEmail, 180),
      automationLevel: validAutomationLevel(input.automationLevel),
      healthPaths: parseHealthPaths(input.healthPaths),
      openRouterKeyProvided: Boolean(openRouterKey),
      openRouterKeyStorage: "not-saved-in-onboarding-json",
      protectedZonesLocked: true,
      nextStep:
        "Agent runtime is installed. Read-only page health checks are available. Real adapters, model calls, and repair actions are not implemented in this prototype.",
    };

    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });

    sendJson(response, 200, { ok: true, config });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid onboarding request",
    });
  }
}

async function handleHealth(response) {
  try {
    const config = await readConfig();
    const baseUrl = normalizeSiteUrl(config.siteUrl);
    const paths = parseHealthPaths(config.healthPaths);
    const checkedAt = new Date().toISOString();
    const pages = await Promise.all(paths.map((healthPath) => checkPage(baseUrl, healthPath)));
    const okCount = pages.filter((page) => page.ok).length;
    const failingCount = pages.length - okCount;
    const status = failingCount === 0 ? "healthy" : okCount > 0 ? "warning" : "down";

    sendJson(response, 200, {
      service: "symbio-agent",
      status,
      checkedAt,
      target: {
        siteName: config.siteName || "",
        baseUrl,
      },
      counts: {
        total: pages.length,
        ok: okCount,
        failing: failingCount,
      },
      pages,
      safety: {
        mode: "read-only",
        productionMutation: false,
        protectedZonesLocked: true,
      },
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "Health check failed",
    });
  }
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const resolvedPath = path.normalize(path.join(publicDir, pathname));

  if (!resolvedPath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(resolvedPath);
    const type = contentTypes[path.extname(resolvedPath)] || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/status") {
    await handleStatus(response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/onboarding") {
    await handleOnboarding(request, response);
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    await handleHealth(response);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(request, response);
    return;
  }

  response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  response.end("Method not allowed");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Symbio onboarding listening on 0.0.0.0:${port}`);
});
