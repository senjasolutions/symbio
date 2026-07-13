/**
 * Service probes — delegates each service type to its registered component.
 * This file exists as a stable public API so the worker loop does not depend
 * on the component registry internals.
 */

import { serviceRegistry, exchange, processDetected, result } from "../components/services/index.js";

/**
 * Probes all configured known services through the component registry.
 * Each service is probed independently — one failure never affects others.
 *
 * @param {Array}  services  - Array of service configuration rows.
 * @param {Set}    processes - Set of detected process names from /proc/[pid]/cmdline.
 * @returns {Array} Array of { serviceId, status, evidence, description, responseTimeMs }.
 */
export const probeServices = async (services, processes) =>
  Promise.all(services.map((service) =>
    serviceRegistry.probe(service.type, service, {
      exchange,
      result,
      processDetected: (type) => processDetected(type, processes),
      processes,
    }),
  ));
