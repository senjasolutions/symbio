/** Password helpers enforce the Phase 1 single-factor policy and Argon2id storage. */

import argon2 from "argon2";

/** Validates password length without imposing counterproductive composition rules. */
export const validatePassword = (password) => {
  if (typeof password !== "string" || Array.from(password).length < 8) {
    throw new Error("Password must contain at least 8 characters.");
  }
  if (Array.from(password).length > 128) {
    throw new Error("Password must contain at most 128 characters.");
  }
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

/** Verifies a password while treating malformed hashes as authentication failure. */
export const verifyPassword = async (hash, password) => {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
};
