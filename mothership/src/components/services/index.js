/**
 * Mothership service component registry — maps each service type to its
 * display metadata (icon, name, description), configuration schema, and
 * SSR template paths. Components are self-contained so adding a new
 * service type only requires dropping a new definition file here and
 * registering it.
 *
 * No agent-side logic runs here; the mothership only uses components for
 * rendering and decoration. Actual probing happens on the agent side.
 */

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

const components = new Map();

export const serviceRegistry = {
  /**
   * Registers a service component definition. Must have a unique `type` string.
   */
  register(component) {
    if (!component || !component.type) {
      throw new Error("Service component must have a unique `type` property.");
    }
    if (components.has(component.type)) {
      console.warn(`[registry] Overwriting registered component "${component.type}".`);
    }
    components.set(component.type, component);
  },

  /** Returns a registered component by type, or undefined. */
  get(type) { return components.get(type); },

  /** Returns an array of all registered components. */
  getAll() { return [...components.values()]; },

  /**
   * Adds component metadata (icon, display name, config schema) to a raw
   * database row for templating.
   */
  decorateService(row) {
    const comp = components.get(row.type);
    return {
      ...row,
      serviceIcon: comp?.icon || "fa-solid fa-server",
      componentDisplayName: comp?.displayName || row.display_name || row.type,
      configSchema: comp?.configSchema || {},
      detailTemplate: comp?.templates?.detail || "service-detail",
    };
  },
};

// Register built-in component definitions
import dockerComponent from "./docker.js";
import pm2Component from "./pm2.js";
import mysqlComponent from "./mysql.js";
import postgresqlComponent from "./postgresql.js";
import redisComponent from "./redis.js";
import nginxComponent from "./nginx.js";
import apacheComponent from "./apache.js";

serviceRegistry.register(dockerComponent);
serviceRegistry.register(pm2Component);
serviceRegistry.register(mysqlComponent);
serviceRegistry.register(postgresqlComponent);
serviceRegistry.register(redisComponent);
serviceRegistry.register(nginxComponent);
serviceRegistry.register(apacheComponent);
