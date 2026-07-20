/**
 * Skills executor — delegates all command execution to command-runner.js.
 *
 * This file exists for backward compatibility. The ACTION_HANDLERS export
 * is built from the COMMAND_REGISTRY in command-runner.js, so every
 * skill execution path goes through the same validation + audit logging.
 *
 * New action types should be added to command-runner.js, not here.
 */

import { buildActionHandlers } from "./command-runner.js";

export const ACTION_HANDLERS = buildActionHandlers();
