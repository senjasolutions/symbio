/**
 * Redis service component definition — fetches live Redis INFO data from
 * the agent bridge and converts each section to an array for Mustache
 * iteration before passing to the template.
 */

/** Converts an object to an array of { key, value } entries for Mustache iteration. */
const toPairs = (obj) => obj ? Object.entries(obj).map(([key, value]) => ({ key, value })) : [];

export default {
  type: "redis",
  displayName: "Redis",
  icon: "fa-solid fa-bolt",
  description: "Redis key-value store — in-memory data structure server.",
  configSchema: {
    host: { type: "string", label: "Host", default: "127.0.0.1" },
    port: { type: "number", label: "Port", default: 6379 },
  },
  templates: {
    detail: "components/services/redis-detail",
  },

  /**
   * Fetches live Redis INFO from the agent bridge. Each INFO section is
   * converted to an array of { key, value } pairs for Mustache iteration.
   */
  fetchData: async () => {
    const { fetchRedisInfo } = await import("../../services/redis.service.js");
    try {
      const data = await fetchRedisInfo();
      const info = data.info;
      if (!info) return { info: null, infoError: "No Redis INFO data returned." };
      return {
        info: {
          server: toPairs(info.server),
          clients: toPairs(info.clients),
          memory: toPairs(info.memory),
          stats: toPairs(info.stats),
          keyspace: toPairs(info.keyspace),
          replication: toPairs(info.replication),
          cpu: toPairs(info.cpu),
        },
        infoError: data.error || "",
      };
    } catch (error) {
      return { info: null, infoError: error.message };
    }
  },
};
