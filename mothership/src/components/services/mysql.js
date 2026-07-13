/**
 * MySQL / MariaDB service component definition — fetches live database
 * status, variable info, schema, and table data from the agent bridge.
 * All operations are read-only; no custom query execution is possible.
 */

export default {
  type: "mysql",
  displayName: "MySQL / MariaDB",
  icon: "fa-solid fa-database",
  description: "MySQL or MariaDB database server — read-only database status, schema browsing, and table data viewer.",
  configSchema: {
    host: { type: "string", label: "Host", default: "127.0.0.1" },
    port: { type: "number", label: "Port", default: 3306 },
    username: { type: "string", label: "Username", default: "root" },
    password: { type: "password", label: "Password", default: "" },
  },
  templates: {
    detail: "components/services/mysql-detail",
  },

  /**
   * Fetches live MySQL status and database list for the detail page.
   */
  fetchData: async () => {
    const { fetchMySQLStatus, fetchMySQLDatabases } = await import("../../services/mysql.service.js");
    try {
      const [statusData, dbData] = await Promise.allSettled([fetchMySQLStatus(), fetchMySQLDatabases()]);
      const status = statusData.status === "fulfilled" ? statusData.value : null;
      const databases = dbData.status === "fulfilled" ? (dbData.value.databases || []) : [];
      // If credentials are missing, show the needsCredentials banner
      if (status?.needsCredentials) {
        return { needsCredentials: true, credentialHint: status.hint, server: null, statusPairs: [], variablePairs: [], databases: [], mysqlError: "" };
      }
      const errors = [];
      if (statusData.status === "rejected") errors.push(statusData.reason?.message);
      if (dbData.status === "rejected") errors.push(dbData.reason?.message);
      const databaseObjects = databases.map((name) => ({ name }));
      return {
        needsCredentials: false,
        server: status?.server || null,
        statusPairs: status?.status ? Object.entries(status.status).map(([k, v]) => ({ key: k, value: v })) : [],
        variablePairs: status?.variables ? Object.entries(status.variables).map(([k, v]) => ({ key: k, value: v })) : [],
        databases: databaseObjects,
        mysqlError: errors.join("; "),
      };
    } catch (error) {
      return { needsCredentials: false, server: null, statusPairs: [], variablePairs: [], databases: [], mysqlError: error.message };
    }
  },
};
