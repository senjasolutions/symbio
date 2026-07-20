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

/**
 * Builds a context string of currently open findings for a skill so the LLM
 * knows what's already been flagged and can reuse existing pattern keys instead
 * of generating new ones with different keys for the same underlying issue.
 *
 * This is a second layer of deduplication before the DB-level pattern match —
 * the LLM sees what's open and either skips re-reporting or reuses the exact
 * same pattern key so upsertFinding() can dedup it.
 *
 * @param {object} models - Sequelize models map
 * @param {string} skillKey - The skill's unique key (e.g., "sus-finder")
 * @param {number} [limit=20] - Max findings to include (token budget)
 * @returns {Promise<string>} Formatted context string, or empty if no open findings
 */
export async function getOpenFindingsContext(models, skillKey, limit = 20) {
  // Look up the skill ID from the key string first
  const skill = await models.Skill.findOne({ where: { key: skillKey }, attributes: ["id"] });
  if (!skill) return "";

  const findings = await models.SkillFinding.findAll({
    include: [{
      model: models.SkillRun,
      as: "skillRun",
      required: true,
      attributes: [],
      where: { skillId: skill.id },
    }],
    where: { status: "open" },
    limit,
    order: [["lastSeenAt", "DESC"]],
  });

  if (!findings.length) return "";

  const lines = findings.map((f) => {
    const desc = (f.description || "").slice(0, 80);
    return `  - [${f.severity}] ${(f.title || "").slice(0, 100)} (pattern: "${f.pattern || ""}")${desc ? ` — ${desc}` : ""}`;
  });

  return `\n\n## PREVIOUSLY REPORTED — STILL OPEN (DO NOT REPORT AGAIN)\n` +
    `These issues are already flagged. If you detect the same underlying problem,\n` +
    `reuse the EXACT pattern key shown below. For new issues, create UNIQUE patterns.\n\n` +
    lines.join("\n") + "\n";
}
