/** Service adapter tests validate credential-free Redis and PostgreSQL evidence. */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { probeServices } from "../src/probes/services.js";
import { serviceRegistry } from "../src/components/services/index.js";

/** Starts a small protocol fixture and returns its bound port and close function. */
const fixture = async (handler) => {
  const server = net.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
};

test("Redis PONG and PostgreSQL SSL negotiation produce operational protocol evidence", async () => {
  const redis = await fixture((socket) => socket.once("data", () => socket.end("+PONG\r\n")));
  const postgres = await fixture((socket) => socket.once("data", () => socket.end("N")));
  try {
    const statuses = await probeServices([
      { id: 1, type: "redis", enabled: true, configuration: { host: "127.0.0.1", port: redis.port } },
      { id: 2, type: "postgresql", enabled: true, configuration: { host: "127.0.0.1", port: postgres.port } },
    ], new Set());
    assert.deepEqual(statuses.map((status) => status.status), ["operational", "operational"]);
    assert.deepEqual(statuses.map((status) => status.evidence), ["protocol", "protocol"]);
  } finally {
    await redis.close();
    await postgres.close();
  }
});

test("PM2 reports process detection without claiming operational health", async () => {
  const [status] = await probeServices([{ id: 3, type: "pm2", enabled: true, configuration: {} }], new Set(["pm2"]));
  assert.equal(status.status, "detected");
  assert.equal(status.evidence, "process");
});

test("probe error isolation: one throwing component does not affect others", async () => {
  const thrower = {
    type: "test-thrower",
    displayName: "Thrower",
    async probe() { throw new Error("Intentional probe failure"); },
  };
  serviceRegistry.register(thrower);
  const statuses = await probeServices([
    { id: 10, type: "test-thrower", enabled: true, configuration: {} },
    { id: 11, type: "docker", enabled: true, configuration: {} },
    { id: 12, type: "pm2", enabled: true, configuration: {} },
  ], new Set(["pm2"]));
  assert.equal(statuses[0].status, "error");
  assert.equal(statuses[0].evidence, "exception");
  assert.equal(statuses[1].status, "operational");
  assert.equal(statuses[2].status, "detected");
});

test("probe returns error for unknown / unregistered service type", async () => {
  const statuses = await probeServices([
    { id: 20, type: "nonexistent-service", enabled: true, configuration: {} },
  ], new Set());
  assert.equal(statuses[0].status, "unknown");
  assert.equal(statuses[0].evidence, "adapter");
});

test("probe returns unknown for disabled services without calling any component", async () => {
  const statuses = await probeServices([
    { id: 30, type: "docker", enabled: false, configuration: {} },
  ], new Set());
  assert.equal(statuses[0].status, "unknown");
  assert.equal(statuses[0].evidence, "disabled");
});
