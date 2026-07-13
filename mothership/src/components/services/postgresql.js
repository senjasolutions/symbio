/**
 * PostgreSQL service component definition — fetches live database status,
 * schema, and table data from the agent bridge.
 */

export default {
  type: "postgresql",
  displayName: "PostgreSQL",
  icon: "fa-solid fa-database",
  description: "PostgreSQL database server — read-only database status, schema browsing, and table data viewer.",
  configSchema: {
    host: { type: "string", label: "Host", default: "127.0.0.1" },
    port: { type: "number", label: "Port", default: 5432 },
    username: { type: "string", label: "Username", default: "postgres" },
    password: { type: "password", label: "Password", default: "" },
  },
  templates: {
    detail: "components/services/postgresql-detail",
  },

  /**
   * Fetches live PostgreSQL status and database list for the detail page.
   */
  fetchData: async () => {
    const { fetchPGStatus, fetchPGDatabases } = await import("../../services/postgresql.service.js");
    try {
      const [statusData, dbData] = await Promise.allSettled([fetchPGStatus(), fetchPGDatabases()]);
      const status = statusData.status === "fulfilled" ? statusData.value : null;
      const databases = dbData.status === "fulfilled" ? (dbData.value.databases || []) : [];
      if (status?.needsCredentials) {
        return { needsCredentials: true, credentialHint: status.hint, server: null, settings: [], stats: null, uptime: null, databases: [], pgError: "" };
      }
      const errors = [];
      if (statusData.status === "rejected") errors.push(statusData.reason?.message);
      if (dbData.status === "rejected") errors.push(dbData.reason?.message);
      return {
        needsCredentials: false,
        server: status?.server || null,
        settings: status?.settings || [],
        stats: status?.stats || null,
        uptime: status?.uptime || null,
        databases: databases.map((name) => ({ name })),
        pgError: errors.join("; "),
      };
    } catch (error) {
      return { needsCredentials: false, server: null, settings: [], stats: null, uptime: null, databases: [], pgError: error.message };
    }
  },
};
