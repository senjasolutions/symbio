/**
 * Service component registry — loads, probes, and registers routes for each
 * known service type as a self-contained module. One component crash never
 * propagates to the worker loop or other components.
 *
 * Each component exports: { type, displayName, probe(service, helpers), routes(router) }
 */

import net from "node:net";

/* ------------------------------------------------------------------ */
/*  Shared helpers — used by all component probes                      */
/* ------------------------------------------------------------------ */

export const DEFAULT_PORTS = { mysql: 3306, postgresql: 5432, redis: 6379 };

export const PROCESS_NAMES = {
  pm2: ["pm2"],
  mysql: ["mysqld", "mariadbd"],
  postgresql: ["postgres"],
  redis: ["redis-server"],
  nginx: ["nginx"],
  apache: ["apache2", "httpd"],
};

/**
 * Runs a bounded TCP exchange and resolves with the first response buffer.
 */
export const exchange = (host, port, writeBuffer = null, timeoutMs = 3000, minimumBytes = 1) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Probe timed out")));
    socket.on("connect", () => { if (writeBuffer) socket.write(writeBuffer); });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks);
      if (response.length >= minimumBytes) finish(null, response);
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
  });

/**
 * Detects whether any normalized host process name matches a service type.
 */
export const processDetected = (type, processes) =>
  (PROCESS_NAMES[type] || []).some((name) => processes.has(name));

/**
 * Creates a consistent status result with bounded operator-facing text.
 */
export const result = (serviceId, status, evidence, description, startedAt = null) => ({
  serviceId, status, evidence, description,
  responseTimeMs: startedAt == null ? null : Date.now() - startedAt,
});

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

const components = new Map();

export const serviceRegistry = {
  /**
   * Registers a service component. Must have a unique `type` string and a
   * `probe(service, helpers)` async function.
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
   * Probes a single service through its registered component.
   * Every error is caught so no component can crash the caller.
   */
  async probe(type, service, helpers) {
    if (helpers?.processes !== undefined && !(helpers.processes instanceof Set)) {
      console.warn(`[registry] probe() called for "${type}" with non-Set processes — coercing.`);
    }
    if (!service.enabled) return result(service.id, "unknown", "disabled", "Monitoring is disabled.");
    const component = components.get(type);
    if (!component) return result(service.id, "unknown", "adapter", `No component registered for type "${type}".`);
    try {
      return await component.probe(service, helpers);
    } catch (error) {
      return result(service.id, "error", "exception", error.message);
    }
  },

  /**
   * Calls each component's `routes(router)` to register bridge endpoints.
   * One failing route registration does not prevent others from registering.
   */
  registerRoutes(router) {
    for (const component of components.values()) {
      if (typeof component.routes !== "function") continue;
      try {
        component.routes(router);
      } catch (error) {
        console.warn(`[registry] Failed to register routes for "${component.type}": ${error.message}`);
      }
    }
  },
};

/**
 * Loads a single component file and registers it. Silently skips files that
 * cannot be imported (e.g. missing dependencies) — logs a warning.
 */
export const loadComponent = async (modulePath) => {
  try {
    const mod = await import(modulePath);
    const component = mod.default || mod;
    if (component && component.type) {
      serviceRegistry.register(component);
      return component;
    }
    console.warn(`[registry] Component at "${modulePath}" has no valid export — skipping.`);
  } catch (error) {
    console.warn(`[registry] Failed to load component at "${modulePath}": ${error.message}`);
  }
  return null;
};

/* ------------------------------------------------------------------ */
/*  Register built-in components                                       */
/* ------------------------------------------------------------------ */

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
