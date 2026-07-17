/**
 * CLI tool to reset a user's password by username or email.
 * Supports direct arguments (for scripting) and interactive prompts.
 *
 * Usage:
 *   node scripts/reset-password.js <username> <new-password>   # non-interactive
 *   node scripts/reset-password.js <username>                  # prompts for password
 *   node scripts/reset-password.js                             # prompts for everything
 */

import process from "node:process";
import { Op } from "sequelize";
import { connectDatabase, closeDatabase, models } from "../src/db/index.js";
import { hashPassword, validatePassword } from "../src/lib/password.js";

/** Prompts for a visible value and trims whitespace. */
const prompt = (rl, label) => new Promise((resolve) => rl.question(label, (value) => resolve(value.trim())));

/**
 * Reads a hidden password from stdin with backspace support.
 * Spaced passphrases are preserved — only Enter commits the value.
 */
const promptHidden = (label) => new Promise((resolve) => {
  const input = process.stdin;
  const output = process.stdout;
  output.write(label);
  let value = "";
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding("utf8");
  const onData = (chunk) => {
    for (const character of chunk) {
      if (character === "\r" || character === "\n") {
        input.off("data", onData);
        input.setRawMode?.(false);
        input.pause();
        output.write("\n");
        resolve(value);
        return;
      }
      if (character === "\u0003") process.exit(130);
      if (character === "\u007f" || character === "\b") {
        value = value.slice(0, -1);
        continue;
      }
      value += character;
    }
  };
  input.on("data", onData);
});

/** Main entry — resolves identity, validates + hashes password, saves. */
const run = async () => {
  const args = process.argv.slice(2);
  let identity = args[0] || "";
  let password = args[1] || "";

  await connectDatabase();
  try {
    // Prompt for missing values
    if (!identity) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      identity = await prompt(rl, "Username or email: ");
      rl.close();
    }
    if (!password) {
      const p1 = await promptHidden("New password (min 8 chars): ");
      const p2 = await promptHidden("Confirm password: ");
      if (p1 !== p2) throw new Error("Passwords do not match.");
      password = p1;
    }

    // Look up user by username or email
    const user = await models.User.findOne({
      where: {
        [Op.or]: [
          { username: identity },
          { email: identity },
        ],
      },
    });
    if (!user) throw new Error(`User "${identity}" not found.`);

    // Validate and hash the new password
    validatePassword(password);
    user.passwordHash = await hashPassword(password);
    await user.save();

    console.log(`Password for ${user.username} (${user.email}) has been reset.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Password reset failed.");
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
};

run();
