const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.SYMBIO_DATA_DIR || "/data";
const publicDir = path.join(__dirname, "public");
const configPath = path.join(dataDir, "onboarding.json");

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

async function handleStatus(response) {
  let configured = false;
  let config = null;

  try {
    const file = await fs.readFile(configPath, "utf8");
    config = JSON.parse(file);
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

    const config = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      mode: safeText(input.mode, 64) || "self-hosted-solo",
      siteName: safeText(input.siteName, 120),
      siteUrl: safeText(input.siteUrl, 240),
      ownerEmail: safeText(input.ownerEmail, 180),
      automationLevel: validAutomationLevel(input.automationLevel),
      openRouterKeyProvided: Boolean(openRouterKey),
      openRouterKeyStorage: "not-saved-in-onboarding-json",
      protectedZonesLocked: true,
      nextStep:
        "Agent runtime is installed. Real monitoring, adapters, and model calls are not implemented in this prototype.",
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

