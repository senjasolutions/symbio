/**
 * Skill registry — auto-registers all built-in skill modules and provides
 * lookup by key. Dynamically imported at scheduler init time.
 */

const SKILL_MODULE_MAP = {};

/** Registers a skill module for a given key. */
export const registerSkill = (key, mod) => {
  SKILL_MODULE_MAP[key] = mod;
};

/** Returns the skill module for a given key, or null if not found. */
export const getSkillModule = (key) => SKILL_MODULE_MAP[key] || null;

/** Returns all registered modules. */
export const getAllModules = () => Object.entries(SKILL_MODULE_MAP).map(([key, module]) => ({ key, module }));
