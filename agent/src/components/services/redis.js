/**
 * Redis service component — validates the Redis protocol via PING and exposes
 * an INFO endpoint that returns parsed server, memory, stats, and keyspace data.
 * Uses raw TCP with the shared exchange() helper — no Redis client library needed.
 */

import { exchange } from "./index.js";

/**
 * Sends a command via TCP to Redis and returns the full response buffer.
 */
const redisCommand = async (host, port, command) => {
  const response = await exchange(host, port, Buffer.from(command), 5000);
  return response.toString();
};

/**
 * Parses Redis INFO response into structured sections.
 * Format: # SectionName\r\nkey:value\r\nkey2:value2\r\n\r\n
 */
const parseInfo = (text) => {
  const sections = {};
  let currentSection = "_root";
  for (const line of text.split("\r\n")) {
    if (line.startsWith("# ")) {
      currentSection = line.slice(2).toLowerCase();
      sections[currentSection] = {};
    } else if (line.includes(":")) {
      const idx = line.indexOf(":");
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      if (currentSection === "_root") {
        sections[currentSection] = sections[currentSection] || {};
        sections[currentSection][key] = value;
      } else {
        sections[currentSection][key] = value;
      }
    }
  }
  return sections;
};

export default {
  type: "redis",
  displayName: "Redis",

  /**
   * Sends a Redis PING over TCP; accepts +PONG, -NOAUTH, or -NOPERM as
   * proof that the Redis protocol is answering.
   */
  async probe(service, { exchange: probeExchange, processDetected, result: makeResult }) {
    const detected = processDetected("redis");
    const configuration = service.configuration || {};
    const host = configuration.host || "127.0.0.1";
    const port = Number(configuration.port || 6379);
    try {
      const response = (await probeExchange(host, port, Buffer.from("*1\r\n$4\r\nPING\r\n"))).toString();
      if (!response.startsWith("+PONG") && !response.startsWith("-NOAUTH") && !response.startsWith("-NOPERM")) {
        throw new Error("Unexpected Redis response");
      }
      return makeResult(service.id, "operational", "protocol",
        `Redis protocol answered on ${host}:${port}.`);
    } catch (error) {
      return makeResult(service.id, detected ? "unavailable" : "not_detected",
        detected ? "protocol" : "process",
        detected
          ? `Process detected but probe failed: ${error.message}`
          : `Service was not detected and probe failed: ${error.message}`);
    }
  },

  /**
   * Registers a bridge endpoint that returns parsed Redis INFO data.
   */
  routes(router) {
    router.get("/api/v1/services/redis/info", async (c) => {
      try {
        const raw = await redisCommand("127.0.0.1", 6379, "*2\r\n$4\r\nINFO\r\n$3\r\nALL\r\n");
        // Strip Redis bulk-string framing ($<length>\r\n...\r\n)
        const body = raw.includes("\r\n") ? raw.slice(raw.indexOf("\r\n") + 2) : raw;
        const info = parseInfo(body);
        return c.json({ ok: true, info });
      } catch (error) {
        return c.json({ ok: true, info: null, error: error.message });
      }
    });
  },
};
