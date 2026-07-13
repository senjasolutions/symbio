/**
 * Docker service component — probes Docker availability and exposes read-only
 * inventory endpoints (containers, volumes, networks) via the Docker UNIX
 * socket. Only GET operations are performed; no container mutation happens.
 *
 * Security: sensitive Docker API fields (Env, Mounts, Labels, Cmd, HostConfig)
 * are intentionally stripped before returning data.
 */

import http from "node:http";

const DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * Makes a GET request to the Docker engine API over the UNIX socket.
 * Only the specified path is requested — no arbitrary paths from the client.
 */
const dockerApi = (path) => new Promise((resolve, reject) => {
  const req = http.get({ socketPath: DOCKER_SOCKET, path }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Docker API returned HTTP ${res.statusCode}`));
      }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Failed to parse Docker API response")); }
    });
  });
  req.on("error", (err) => {
    if (err.code === "ENOENT") reject(new Error("Docker socket not found at " + DOCKER_SOCKET + ". Ensure the socket is mounted into the agent container (compose.yaml: - /var/run/docker.sock:/var/run/docker.sock:ro)."));
    else if (err.code === "EACCES") reject(new Error("Permission denied on Docker socket. The node user needs the docker group GID as a supplementary group. Check SYMBIO_DOCKER_GROUP_GID in compose.yaml (your host GID: getent group docker | cut -d: -f3)."));
    else reject(new Error("Docker API request failed: " + err.message));
  });
  req.end();
});

/**
 * Maps a raw Docker container object to a safe subset of fields.
 * Environment variables, mounts, labels, and command-line args are excluded.
 */
const safeContainer = (raw) => ({
  id: raw.Id ? raw.Id.substring(0, 12) : "",
  name: raw.Names && raw.Names[0] ? raw.Names[0].replace(/^\//, "") : "",
  image: raw.Image || "",
  state: raw.State || "",
  running: raw.State === "running",
  status: raw.Status || "",
  created: raw.Created ? new Date(raw.Created * 1000).toISOString().replace("T", " ").replace(/\..+/, "") : "",
  ports: (raw.Ports || []).map((p) => ({
    ip: p.IP || "", publicPort: p.PublicPort || 0, privatePort: p.PrivatePort || 0, type: p.Type || "",
  })),
});

/**
 * Maps a raw Docker container inspect result to a safe detailed subset.
 */
const safeContainerDetail = (raw) => ({
  id: raw.Id || "",
  name: raw.Name ? raw.Name.replace(/^\//, "") : "",
  image: raw.Config?.Image || "",
  platform: raw.Platform || "",
  created: raw.Created || "",
  state: raw.State ? {
    status: raw.State.Status || "",
    running: Boolean(raw.State.Running),
    startedAt: raw.State.StartedAt || "",
    finishedAt: raw.State.FinishedAt && raw.State.FinishedAt.startsWith("0001") ? "" : raw.State.FinishedAt || "",
    restartCount: typeof raw.State.RestartCount === "number" ? raw.State.RestartCount : 0,
  } : {},
  ports: Object.entries(raw.NetworkSettings?.Ports || {}).map(([containerPort, bindings]) => ({
    containerPort, privatePort: parseInt(containerPort.split("/")[0]) || 0,
    protocol: containerPort.split("/")[1] || "tcp",
    bindings: (bindings || []).map((b) => ({ hostIp: b.HostIp || "", hostPort: b.HostPort || "" })),
  })),
  network: (() => {
    const nets = raw.NetworkSettings?.Networks || {};
    const names = Object.keys(nets);
    if (!names.length) return null;
    const first = nets[names[0]];
    return { name: names[0], ip: first.IPAddress || "", gateway: first.Gateway || "" };
  })(),
  restartCount: typeof raw.RestartCount === "number" ? raw.RestartCount : 0,
});

/**
 * Maps a raw Docker volume to a safe subset.
 */
const safeVolume = (raw) => ({
  name: raw.Name || "",
  driver: raw.Driver || "",
  mountpoint: raw.Mountpoint || "",
});

/**
 * Maps a raw Docker network to a safe subset.
 */
const safeNetwork = (raw) => ({
  id: raw.Id ? raw.Id.substring(0, 12) : "",
  name: raw.Name || "",
  driver: raw.Driver || "",
  scope: raw.Scope || "",
  subnet: raw.IPAM?.Config?.[0]?.Subnet || "",
  gateway: raw.IPAM?.Config?.[0]?.Gateway || "",
});

export default {
  type: "docker",
  displayName: "Docker",

  /**
   * Docker is considered operational whenever the agent is running.
   */
  async probe(service, { result: makeResult }) {
    return makeResult(service.id, "operational", "heartbeat",
      "Fresh agent execution proves Docker is operating.");
  },

  /**
   * Registers read-only inventory bridge endpoints for Docker.
   * Every endpoint is individually catch-wrapped so one failure never
   * blocks the others.
   */
  routes(router) {
    // ---- Container list ----
    router.get("/api/v1/services/docker/containers", async (context) => {
      try {
        const raw = await dockerApi("/containers/json?all=true");
        return context.json({ ok: true, containers: (raw || []).map(safeContainer) });
      } catch (error) {
        return context.json({ ok: false, error: error.message }, 400);
      }
    });

    // ---- Container detail ----
    router.get("/api/v1/services/docker/containers/:id", async (context) => {
      try {
        const containerId = context.req.param("id");
        if (!/^[a-f0-9]{12,}$/i.test(containerId)) {
          return context.json({ ok: false, error: "Invalid container ID format." }, 400);
        }
        const raw = await dockerApi("/containers/" + containerId + "/json");
        return context.json({ ok: true, container: safeContainerDetail(raw) });
      } catch (error) {
        return context.json({ ok: false, error: error.message }, 400);
      }
    });

    // ---- Volume list ----
    router.get("/api/v1/services/docker/volumes", async (context) => {
      try {
        const raw = await dockerApi("/volumes");
        return context.json({ ok: true, volumes: (raw?.Volumes || []).map(safeVolume) });
      } catch (error) {
        return context.json({ ok: false, error: error.message }, 400);
      }
    });

    // ---- Network list ----
    router.get("/api/v1/services/docker/networks", async (context) => {
      try {
        const raw = await dockerApi("/networks");
        return context.json({ ok: true, networks: (raw || []).map(safeNetwork) });
      } catch (error) {
        return context.json({ ok: false, error: error.message }, 400);
      }
    });
  },
};
