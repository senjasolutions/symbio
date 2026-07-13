/** Integration test proves migrations, authentication rendering, and idempotent reports share one schema. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "symbio-mothership-test-"));
process.env.SYMBIO_DATABASE_PATH = path.join(tempDirectory, "mothership.sqlite");
process.env.SYMBIO_AGENT_TOKEN = "integration-agent-token";
process.env.SYMBIO_VIEWS_PATH = path.resolve("src/views");

const { createPublicApp } = await import("../src/app.js");
const { connectDatabase, closeDatabase, models } = await import("../src/db/index.js");
const { runMigrations } = await import("../src/db/migrations.js");
const { hashPassword } = await import("../src/lib/password.js");
const { buildAgentConfig, cleanupHistory, ingestReportBatch } = await import("../src/services/report.service.js");

test.before(async () => {
  await connectDatabase();
  await runMigrations();
});

test.after(async () => {
  await closeDatabase();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

test("initial migration seeds one server, one agent, and seven known services", async () => {
  assert.equal(await models.Server.count(), 1);
  assert.equal(await models.Agent.count(), 1);
  assert.equal(await models.ServerService.count(), 7);
});

test("application log sources migrate and join the compatible agent configuration", async () => {
  const server = await models.Server.findOne();
  const application = await models.Application.create({
    serverId: server.id, name: "log_source_app", displayName: "Log Source App", healthCheckUrl: "http://127.0.0.1:9998/health",
  });
  const source = await models.ApplicationLog.create({ applicationId: application.id, displayName: "Error log", filePath: "/var/log/log-source-app.log", tailLines: 200 });
  const configuration = await buildAgentConfig();
  assert.equal(configuration.schemaVersion, 1);
  assert.deepEqual(configuration.applicationLogs.find((item) => item.id === source.id), {
    id: source.id, applicationId: application.id, filePath: "/var/log/log-source-app.log", tailLines: 200,
  });
});

test("public CSS, JavaScript, icon, and tag assets resolve without authentication", async () => {
  const app = createPublicApp();
  const [styles, script, icons, tagify] = await Promise.all([
    app.request("/assets/styles.css"), app.request("/assets/app.js"), app.request("/vendor/fontawesome/css/all.min.css"), app.request("/vendor/tagify.js"),
  ]);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") || "", /text\/css/);
  assert.match(await styles.text(), /--symbio-sidebar/);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);
  assert.match(await script.text(), /data-summary-key/);
  assert.equal(icons.status, 200);
  assert.equal(tagify.status, 200);
});

test("login and server-rendered application CRUD work with session CSRF", async () => {
  await models.User.create({
    username: "operator", displayName: "Server Operator", email: "operator@example.test",
    passwordHash: await hashPassword("a sufficiently long test passphrase"), role: "superadmin",
  });
  const app = createPublicApp();
  const loginPage = await app.request("/login");
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Server monitoring login/);
  const response = await app.request("/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "a sufficiently long test passphrase" }),
  });
  assert.equal(response.status, 302);
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /symbio_session=/);
  assert.equal(await models.Session.count(), 1);
  const session = await models.Session.findOne();
  const createResponse = await app.request("/applications", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({
      _csrf: session.csrfToken, name: "test_app", displayName: "Test Application",
      healthCheckUrl: "http://127.0.0.1:9999/health", healthCheckTimeoutMs: "5000",
      slowThresholdMs: "1500", responseTextMatch: "o[kK]", tagNames: "Production, Node.js",
    }),
  });
  assert.equal(createResponse.status, 302);
  const application = await models.Application.findOne({ where: { name: "test_app" } });
  assert.ok(application);
  assert.equal(await models.ApplicationTag.count(), 2);
  const listResponse = await app.request("/applications", { headers: { cookie } });
  assert.equal(listResponse.status, 200);
  assert.match(await listResponse.text(), /Test Application/);
  const deleteResponse = await app.request(`/applications/${application.id}/delete`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ _csrf: session.csrfToken }),
  });
  assert.equal(deleteResponse.status, 302);
  assert.equal(await models.Application.count({ where: { name: "test_app" } }), 0);
  assert.equal(await models.Application.count({ where: { name: "test_app" }, paranoid: false }), 1);
});

test("duplicate agent reports are acknowledged without duplicate samples", async () => {
  const service = await models.ServerService.findOne();
  const report = {
    id: "integration-report-1", observedAt: new Date().toISOString(),
    host: { hostname: "test-host", primaryIp: "192.0.2.10", operatingSystem: "Ubuntu Test", kernelVersion: "test", hardware: { architecture: "x64", cpuModel: "Test CPU", logicalCores: 2 }, storage: [{ mountPoint: "/", fsType: "ext4", totalBytes: 600, usedBytes: 300, availableBytes: 300 }], networking: [{ name: "eth0", state: "up", rxBytes: 1, txBytes: 2, addresses: [] }] },
    metrics: { cpuPercent: 20, cpuCores: [{ id: "cpu0", percent: 15 }, { id: "cpu1", percent: 25 }], memoryUsedBytes: 100, memoryAvailableBytes: 100, memoryTotalBytes: 200, memoryPercent: 50, swapUsedBytes: 10, swapTotalBytes: 20, diskUsedBytes: 300, diskTotalBytes: 600, diskPercent: 50, load1: 0.1, load5: 0.2, load15: 0.3, uptimeSeconds: 1000 },
    services: [{ serviceId: service.id, status: "operational", evidence: "protocol", description: "test", responseTimeMs: 2 }],
    applications: [],
  };
  const payload = { schemaVersion: 1, agentId: "main-agent", reports: [report] };
  assert.deepEqual(await ingestReportBatch(payload), { inserted: 1, duplicates: 0 });
  assert.deepEqual(await ingestReportBatch(payload), { inserted: 0, duplicates: 1 });
  assert.equal(await models.ServerStatus.count(), 1);
  assert.equal(await models.ServerServiceStatus.count(), 1);
  const [server, status] = await Promise.all([models.Server.findByPk(1), models.ServerStatus.findOne()]);
  assert.match(server.storageJson, /ext4/);
  assert.match(status.cpuCoresJson, /cpu0/);
});

test("server detail renders every collected host identity and runtime field", async () => {
  const app = createPublicApp();
  const login = await app.request("/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "a sufficiently long test passphrase" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const response = await app.request("/servers/1", { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /test-host/);
  assert.match(html, /192\.0\.2\.10/);
  assert.match(html, /Ubuntu Test/);
  assert.match(html, /Load \(1 \/ 5 \/ 15 min\)/);
  assert.match(html, /Storage/);
  assert.match(html, /Networking/);
  assert.match(html, /Manage Server/);
  assert.match(html, /16m/);
});

test("authenticated pages render the clean-room administrative navigation shell", async () => {
  const app = createPublicApp();
  const login = await app.request("/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "a sufficiently long test passphrase" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const response = await app.request("/servers", { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Main Server/);
  assert.match(html, /Monitoring/);
  assert.match(html, /nav-link is-active/);
});

test("retention cleanup removes expired histories before their report receipt", async () => {
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const [agent, server, service] = await Promise.all([
    models.Agent.findOne(), models.Server.findOne(), models.ServerService.findOne(),
  ]);
  await models.AgentReport.create({
    id: "expired-report", agentId: agent.id, observedAt: oldDate, receivedAt: oldDate,
  });
  await models.ServerStatus.create({
    serverId: server.id, reportId: "expired-report", observedAt: oldDate, receivedAt: oldDate,
  });
  await models.ServerServiceStatus.create({
    serverServiceId: service.id, reportId: "expired-report", status: "unknown",
    evidence: "test", observedAt: oldDate,
  });

  await cleanupHistory();

  assert.equal(await models.ServerStatus.count({ where: { reportId: "expired-report" } }), 0);
  assert.equal(await models.ServerServiceStatus.count({ where: { reportId: "expired-report" } }), 0);
  assert.equal(await models.AgentReport.count({ where: { id: "expired-report" } }), 0);
  assert.equal(await models.AgentReport.count({ where: { id: "integration-report-1" } }), 1);
});
