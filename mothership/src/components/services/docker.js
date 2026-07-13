/**
 * Docker service component definition — provides the mothership-side metadata
 * (icon, display info, template paths) and a fetchData callback that loads
 * live container/volume/network inventory from the agent bridge.
 *
 * Error isolation: uses Promise.allSettled so one failing API never blocks
 * others. Only throws (propagating to the route handler) when ALL three
 * endpoints fail, which surfaces the real root cause instead of silently
 * returning empty arrays.
 */

export default {
  type: "docker",
  displayName: "Docker",
  icon: "fa-brands fa-docker",
  description: "Docker container runtime — monitors whether the Docker daemon is available on the host.",
  configSchema: {},
  templates: {
    detail: "components/services/docker-detail",
    containerDetail: "components/services/docker-container-detail",
  },

  /**
   * Fetches live Docker inventory from the agent bridge. Three calls run in
   * parallel. If all three fail, the error is thrown so the route handler
   * displays the real reason. If only some fail, partial data is returned
   * with per-section warnings.
   */
  fetchData: async () => {
    const { fetchDockerContainers, fetchDockerVolumes, fetchDockerNetworks } =
      await import("../../services/docker.service.js");

    const results = await Promise.allSettled([
      fetchDockerContainers(),
      fetchDockerVolumes(),
      fetchDockerNetworks(),
    ]);

    const containers = results[0].status === "fulfilled" ? results[0].value.containers : null;
    const volumes    = results[1].status === "fulfilled" ? results[1].value.volumes : null;
    const networks   = results[2].status === "fulfilled" ? results[2].value.networks : null;

    // If every single endpoint failed, throw so the route handler shows the
    // root error instead of silently returning empty data.
    if (containers === null && volumes === null && networks === null) {
      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason?.message || "Unknown error");
      throw new Error(errors[0] || "Docker inventory is unavailable.");
    }

    return {
      containers: containers || [],
      volumes: volumes || [],
      networks: networks || [],
      containersError: containers === null ? results[0].reason?.message || "Container listing failed." : "",
      volumesError: volumes === null ? results[1].reason?.message || "Volume listing failed." : "",
      networksError: networks === null ? results[2].reason?.message || "Network listing failed." : "",
    };
  },
};
