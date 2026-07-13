/** Agent persistence test proves cached config and acknowledgement-safe outbox behavior. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symbio-agent-test-"));
process.env.SYMBIO_AGENT_DATABASE_PATH = path.join(directory, "agent.sqlite");
const db = await import("../src/db.js");

test.before(() => db.connectAgentDatabase());
test.after(async () => { await db.sequelize.close(); await fs.rm(directory, { recursive: true, force: true }); });

test("configuration and reports survive database reads", async () => {
  const configuration = { schemaVersion: 1, version: 3, applications: [], services: [] };
  await db.writeCachedConfig(configuration);
  assert.deepEqual(await db.readCachedConfig(), configuration);
  await db.enqueueReport({ id: "outbox-1", observedAt: new Date().toISOString() });
  const rows = await db.readOutboxBatch();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "outbox-1");
});

test("outbox keeps only the newest 2,880 reports", async () => {
  await db.OutboxReport.destroy({ truncate: true });
  const start = Date.now() - 3_000;
  // Bulk seeding keeps this boundary test fast while enqueueReport exercises
  // the same pruning branch used after a prolonged mothership outage.
  await db.OutboxReport.bulkCreate(Array.from({ length: 2_880 }, (_, index) => ({
    id: `bounded-${index}`,
    payload: JSON.stringify({ id: `bounded-${index}` }),
    createdAt: new Date(start + index),
  })));

  await db.enqueueReport({ id: "bounded-newest", observedAt: new Date().toISOString() });

  assert.equal(await db.OutboxReport.count(), 2_880);
  assert.equal(await db.OutboxReport.count({ where: { id: "bounded-0" } }), 0);
  assert.equal(await db.OutboxReport.count({ where: { id: "bounded-newest" } }), 1);
});
