/**
 * Nginx service component definition — fetches nginx modules and enabled
 * sites info from the agent bridge.
 */

export default {
  type: "nginx",
  displayName: "Nginx",
  icon: "fa-solid fa-globe",
  description: "Nginx web server — high-performance HTTP server and reverse proxy.",
  configSchema: {
    probeUrl: { type: "url", label: "HTTP probe URL", default: "" },
  },
  templates: {
    detail: "components/services/nginx-detail",
  },

  /**
   * Fetches nginx modules and site info from the agent bridge.
   */
  fetchData: async () => {
    const { fetchNginxInfo } = await import("../../services/nginx.service.js");
    try {
      const data = await fetchNginxInfo();
      return {
        nginxModules: data.modules || [],
        nginxSites: data.sites || [],
        nginxError: data.error || "",
      };
    } catch (error) {
      return { nginxModules: [], nginxSites: [], nginxError: error.message };
    }
  },
};
