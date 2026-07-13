/**
 * PM2 service component definition — provides metadata and fetches live
 * process list from the agent bridge.
 */

export default {
  type: "pm2",
  displayName: "PM2",
  icon: "fa-solid fa-diagram-project",
  description: "PM2 process manager — manages Node.js application processes.",
  configSchema: {},
  templates: {
    detail: "components/services/pm2-detail",
  },

  /**
   * Fetches live PM2 process list from the agent bridge. Returns processes
   * array and an optional error string if the agent is unreachable or the
   * PM2 daemon cannot be contacted.
   */
  fetchData: async () => {
    const { fetchPM2Processes } = await import("../../services/pm2.service.js");
    try {
      const data = await fetchPM2Processes();
      return { processes: data.processes || [], processesError: data.error || "" };
    } catch (error) {
      return { processes: [], processesError: error.message };
    }
  },
};
