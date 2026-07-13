/**
 * Apache service component definition — fetches Apache modules and virtual
 * host info from the agent bridge.
 */

export default {
  type: "apache",
  displayName: "Apache",
  icon: "fa-solid fa-server",
  description: "Apache HTTP server — the most widely used web server software.",
  configSchema: {
    probeUrl: { type: "url", label: "HTTP probe URL", default: "" },
  },
  templates: {
    detail: "components/services/apache-detail",
  },

  /**
   * Fetches Apache modules and virtual hosts from the agent bridge.
   */
  fetchData: async () => {
    const { fetchApacheInfo } = await import("../../services/apache.service.js");
    try {
      const data = await fetchApacheInfo();
      return {
        apacheModules: data.modules || [],
        apacheSites: data.sites || [],
        apacheError: data.error || "",
      };
    } catch (error) {
      return { apacheModules: [], apacheSites: [], apacheError: error.message };
    }
  },
};
