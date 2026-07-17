/** Password helpers enforce the Phase 1 single-factor policy and Argon2id storage. */

import argon2 from "argon2";
import process from "node:process";

/** The expected argon2id hash prefix used for format validation. */
const ARGON2ID_PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";

/** Validates password length without imposing counterproductive composition rules. */
export const validatePassword = (password) => {
  if (typeof password !== "string" || Array.from(password).length < 8) {
    throw new Error("Password must contain at least 8 characters.");
  }
  if (Array.from(password).length > 128) {
    throw new Error("Password must contain at most 128 characters.");
  }
};

/** Checks that a stored hash looks like a valid argon2id digest before verification. */
const validateHashFormat = (hash) => {
  if (typeof hash !== "string") return false;
  if (!hash.startsWith(ARGON2ID_PREFIX)) return false;
  // Expected structure: prefix + <base64> (fixed delimiter pattern)
  // After the prefix we expect base64-encoded salt+hash separated by $
  const suffix = hash.slice(ARGON2ID_PREFIX.length);
  if (!suffix.includes("$")) return false;
  return true;
};

/** Hashes a validated password using the approved minimum Argon2id cost. */
export const hashPassword = async (password) => {
  validatePassword(password);
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
};

/**
 * Verifies a password against the stored hash.
 * Returns `false` for wrong passwords, malformed hashes, or argon2 errors —
 * but logs the real cause to stderr so operators can distinguish
 * "user typed wrong password" from "hash got corrupted."
 */
export const verifyPassword = async (hash, password) => {
  if (!validateHashFormat(hash)) {
    console.error("PASSWORD: stored hash does not match expected argon2id format — possible corruption.");
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch (error) {
    console.error("PASSWORD: argon2 verify threw an exception:", error instanceof Error ? error.message : error);
    return false;
  }
};
