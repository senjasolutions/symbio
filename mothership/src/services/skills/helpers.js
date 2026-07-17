/**
 * Shared helpers for skill modules — dedup finding creation, notification
 * batching, and common report() utilities.
 *
 * Dedup logic: before inserting a new finding, check if an open finding
 * with the same `pattern` already exists for this skill. If so, increment
 * seen_count and update last_seen_at instead of creating a new row.
 */

/**
 * Upserts a finding by pattern: creates a new finding or bumps the counter
 * on an existing open one with the same pattern from the same skill.
 *
 * @param {object} opts
 * @param {object} opts.models - Sequelize models map
 * @param {object} opts.run - SkillRun instance (must have skillId)
 * @param {object} opts.finding - LLM finding object { pattern, message, probableCause, severity, source, isSimpleFix, suggestedFix }
 * @param {object} [opts.config] - Skill config (unused currently, for future use)
 * @returns {Promise<{finding: object, isNew: boolean}>}
 */
export async function upsertFinding({ models, run, finding, config }) {
  const pattern = String(finding.pattern || "").trim();
  if (pattern && run.skillId) {
    // Find existing open finding with same pattern from same skill
    const existing = await models.SkillFinding.findOne({
      include: [{
        model: models.SkillRun,
        required: true,
        attributes: [],
        as: "skillRun",
        where: { skillId: run.skillId },
      }],
      where: { pattern, status: "open" },
    });
    if (existing) {
      // Bump counters, update description, keep original title
      existing.seenCount = (existing.seenCount || 0) + 1;
      existing.lastSeenAt = new Date();
      if (finding.probableCause) existing.description = finding.probableCause;
      await existing.save();
      return { finding: existing, isNew: false };
    }
  }

  // No match — create fresh
  const newFinding = await models.SkillFinding.create({
    skillRunId: run.id,
    severity: finding.severity || "info",
    title: (finding.message || "Finding").slice(0, 200),
    description: finding.probableCause || "",
    source: finding.source || "",
    isSimpleFix: finding.isSimpleFix || false,
    suggestedFix: finding.suggestedFix || "",
    pattern,
    status: "open",
    seenCount: 1,
    lastSeenAt: new Date(),
    createdAt: new Date(),
  });
  return { finding: newFinding, isNew: true };
}
