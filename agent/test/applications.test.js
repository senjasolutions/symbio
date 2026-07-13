/** Application probe tests exercise status, regex matching, and redirects against a local server. */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeApplication } from "../src/probes/applications.js";

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "/healthy" }); response.end(); return; }
    if (request.url === "/failure") { response.writeHead(500); response.end("failure"); return; }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("healthy marker");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test("healthy and redirected applications classify as up", async () => {
  const direct = await probeApplication({ id: 1, url: `${baseUrl}/healthy`, timeoutMs: 1000, slowThresholdMs: 900, responseTextMatch: "marker" });
  assert.equal(direct.status, "up");
  const redirected = await probeApplication({ id: 2, url: `${baseUrl}/redirect`, timeoutMs: 1000, slowThresholdMs: 900, responseTextMatch: "marker" });
  assert.equal(redirected.status, "up");
  assert.match(redirected.finalUrl, /healthy$/);
});

test("response regular expressions match and missing matches classify as down", async () => {
  const failed = await probeApplication({ id: 3, url: `${baseUrl}/failure`, timeoutMs: 1000, slowThresholdMs: 900 });
  assert.equal(failed.status, "down");
  assert.equal(failed.statusCode, 500);
  const regex = await probeApplication({ id: 4, url: `${baseUrl}/healthy`, timeoutMs: 1000, slowThresholdMs: 900, responseTextMatch: "mar[kK]er" });
  const missing = await probeApplication({ id: 5, url: `${baseUrl}/healthy`, timeoutMs: 1000, slowThresholdMs: 900, responseTextMatch: "absent.+value" });
  assert.equal(regex.status, "up");
  assert.equal(missing.status, "down");
  assert.match(missing.failureReason, /regular expression/);
});
