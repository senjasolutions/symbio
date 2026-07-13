/**
 * Interactive superadmin seeder reads secrets directly from the terminal so
 * installation logs and shell history never contain the password.
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
 * A paste may arrive as one data chunk, so every character must be processed
 * individually or the trailing Enter would become part of the password.
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
  const username = await prompt(rl, "Username: ");
  const displayName = await prompt(rl, "Display name: ");
  const email = await prompt(rl, "Email: ");
  rl.close();
  const password = await promptHidden("Password (minimum 8 characters): ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(username)) throw new Error("Username format is invalid.");
  if (!email.includes("@") || email.length > 180) throw new Error("Email format is invalid.");
  if (!displayName || displayName.length > 120) throw new Error("Display name is required.");
  const passwordHash = await hashPassword(password);
  await models.User.create({ username, displayName, email, passwordHash, role: "superadmin" });
  console.log(`Superadmin ${username} created.`);
} catch (error) {
  rl.close();
  console.error(error instanceof Error ? error.message : "Superadmin creation failed.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
