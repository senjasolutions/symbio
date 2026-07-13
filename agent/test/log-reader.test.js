/** Registered log-reader tests prove bounded tails/searches never accept arbitrary paths. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRegisteredTail, searchRegisteredLog } from "../src/log-reader.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "symbio-log-reader-"));
const logsDirectory = path.join(root, "logs");
await fs.mkdir(logsDirectory);
const logPath = path.join(logsDirectory, "application.log");
await fs.writeFile(logPath, ["first", "needle alpha", "third", "needle beta", "last"].join("\n"));
const configuration = { applicationLogs: [{ id: 7, applicationId: 1, filePath: "/logs/application.log", tailLines: 200 }] };

test.after(() => fs.rm(root, { recursive: true, force: true }));

test("registered tails use source IDs, bounded limits, and plain text output", async () => {
  const tail = await readRegisteredTail(configuration, root, 7, 50);
  assert.match(tail.text, /needle beta/);
  assert.equal(tail.truncated, false);
  await assert.rejects(() => readRegisteredTail(configuration, root, 7, 42), /invalid/);
  await assert.rejects(() => readRegisteredTail({ applicationLogs: [{ id: 8, filePath: "/../etc/passwd", tailLines: 200 }] }, root, 8, 200), /traversal/);
  await assert.rejects(() => readRegisteredTail({ applicationLogs: [{ id: 10, filePath: "/var/lib/docker/containers/log.json", tailLines: 200 }] }, root, 10, 200), /not supported/);
});

test("literal search returns recent bounded occurrences with context", async () => {
  const search = await searchRegisteredLog(configuration, root, 7, "needle");
  assert.match(search.text, /Occurrence 1\/2/);
  assert.match(search.text, /> needle alpha/);
  assert.match(search.text, /needle beta/);
  await assert.rejects(() => searchRegisteredLog(configuration, root, 7, ""), /1–500/);
});

test("symbolic links are rejected instead of followed into another host file", async () => {
  await fs.symlink("/etc/passwd", path.join(logsDirectory, "linked.log"));
  const linked = { applicationLogs: [{ id: 9, applicationId: 1, filePath: "/logs/linked.log", tailLines: 200 }] };
  await assert.rejects(() => readRegisteredTail(linked, root, 9, 200), /regular file/);
});
