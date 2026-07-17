/**
 * Proof system — captures before/after state for every executed skill action.
 * Provides an audit trail so users can verify what changed.
 */

import { collectSkillData, executeSkillActions } from "../agent-client.js";

/** Captures the relevant system state before or after an action. */
const captureState = async (actionType, params, hostRoot) => {
  const state = {};
  // All actions should capture disk state (universal proof)
  try {
    const diskResult = await collectSkillData(["disk"], {});
    state.disk = diskResult.disk || {};
  } catch {}
  // Service restart: capture service status
  if (actionType === "systemctl.restart" && params?.service) {
    try {
      const svcResult = await collectSkillData(["service-status"], { services: [params.service] });
      state.serviceStatus = svcResult.serviceStatus || {};
    } catch {}
  }
  // Package upgrade: capture package list
  if (actionType === "apt.upgrade") {
    try {
      const pkgResult = await collectSkillData(["packages"], {});
      state.packages = pkgResult.packages || {};
    } catch {}
  }
  return state;
};

/** Formats captured state into a short human-readable string for proof display. */
const formatState = (state) => {
  const lines = [];
  if (state.disk?.disks?.length) {
    for (const d of state.disk.disks) {
      lines.push(`Disk ${d.mount}: ${d.usePercent}% used (${d.used}/${d.size})`);
    }
  }
  if (state.disk?.journalctlSize) {
    lines.push(`Journalctl: ${state.disk.journalctlSize}`);
  }
  if (state.serviceStatus?.services?.length) {
    for (const s of state.serviceStatus.services) {
      lines.push(`Service ${s.name}: ${s.isActive}`);
    }
  }
  if (state.packages?.installed?.length) {
    const count = state.packages.installed.length;
    lines.push(`Installed packages: ${count}`);
  }
  if (state.packages?.updates?.length) {
    for (const u of state.packages.updates) {
      lines.push(`Update ${u.pkg}: ${u.newVersion}`);
    }
  }
  return lines.join("\n");
};

/** Computes a human-readable diff summary between before and after states. */
const computeDiff = (actionType, before, after) => {
  const changes = [];
  // Disk usage change
  const beforeDisk = before.disk?.disks?.[0];
  const afterDisk = after.disk?.disks?.[0];
  if (beforeDisk && afterDisk && beforeDisk.usePercent !== afterDisk.usePercent) {
    changes.push(`Disk: ${beforeDisk.usePercent}% → ${afterDisk.usePercent}%`);
  }
  // Journalctl size change
  if (before.disk?.journalctlSize && after.disk?.journalctlSize && before.disk.journalctlSize !== after.disk.journalctlSize) {
    changes.push(`Journal: ${before.disk.journalctlSize} → ${after.disk.journalctlSize}`);
  }
  // Service status change
  if (before.serviceStatus?.services?.length) {
    for (const bs of before.serviceStatus.services) {
      const as = after.serviceStatus?.services?.find((s) => s.name === bs.name);
      if (as && bs.isActive !== as.isActive) {
        changes.push(`Service ${bs.name}: ${bs.isActive} → ${as.isActive}`);
      }
    }
  }
  return changes.length ? changes.join("; ") : "No significant state change detected.";
};

/**
 * Executes a single skill action with before/after proof capture.
 *
 * @param {{ action: string, params: object }} action - The action to execute.
 * @returns {{ before: object, after: object, diff: string, execution: object }}
 */
export const executeWithProof = async (action) => {
  const before = await captureState(action.action, action.params);
  const execResult = await executeSkillActions([action]);
  const after = await captureState(action.action, action.params);
  const diff = computeDiff(action.action, before, after);
  return {
    before,
    after,
    diff,
    execution: execResult.results?.[0] || {},
    beforeSummary: formatState(before),
    afterSummary: formatState(after),
  };
};
