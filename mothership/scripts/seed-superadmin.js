/**
 * Interactive superadmin seeder reads secrets directly from the terminal so
 * installation logs and shell history never contain the password.
 *
 * Non-interactive mode: set SYMBIO_SEED_USERNAME, SYMBIO_SEED_DISPLAY_NAME,
 * SYMBIO_SEED_EMAIL, SYMBIO_SEED_PASSWORD, and SYMBIO_SEED_PASSWORD_CONFIRM.
 */

import process from "node:process";
import readline from "node:readline";
import { connectDatabase, closeDatabase, models } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { hashPassword } from "../src/lib/password.js";

/** Prompts for a visible value and trims surrounding whitespace. */
const prompt = (rl, label) => new Promise((resolve) => rl.question(label, (value) => resolve(value.trim())));

/**
 * Temporarily masks terminal input while preserving spaces inside passphrases.
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  await connectDatabase();
  await runMigrations();

  const username = process.env.SYMBIO_SEED_USERNAME || await prompt(rl, "Username: ");
  const displayName = process.env.SYMBIO_SEED_DISPLAY_NAME || await prompt(rl, "Display name: ");
  const email = process.env.SYMBIO_SEED_EMAIL || await prompt(rl, "Email: ");

  let password, confirmation;
  if (process.env.SYMBIO_SEED_PASSWORD) {
    password = process.env.SYMBIO_SEED_PASSWORD;
    confirmation = process.env.SYMBIO_SEED_PASSWORD_CONFIRM;
  } else {
    rl.close();
    password = await promptHidden("Password (minimum 8 characters): ");
    confirmation = await promptHidden("Confirm password: ");
  }

  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(username)) throw new Error("Username format is invalid.");
  if (!email.includes("@") || email.length > 180) throw new Error("Email format is invalid.");
  if (!displayName || displayName.length > 120) throw new Error("Display name is required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  const passwordHash = await hashPassword(password);
  await models.User.create({ username, displayName, email, passwordHash, role: "superadmin" });
  console.log(`Superadmin ${username} created.`);
} catch (error) {
  try { rl.close(); } catch {}
  console.error(error instanceof Error ? error.message : "Superadmin creation failed.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
