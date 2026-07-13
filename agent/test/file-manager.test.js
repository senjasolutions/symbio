/** File-manager security tests prove path whitelisting, blocklists, and containment work. */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDirectory, viewFileContent, getDirectoryTree } from "../src/file-manager.js";

// Set up a simulated host root with allowed and disallowed directories
const root = await fs.mkdtemp(path.join(os.tmpdir(), "symbio-fm-"));
const hostRoot = path.join(root, "host");
await fs.mkdir(path.join(hostRoot, "home", "user"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "etc"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "root"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "boot"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "etc"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "sys"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "proc"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "dev"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "var", "lib"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "var", "lib", "docker"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "usr"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "var"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "mnt"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "srv"), { recursive: true });
await fs.mkdir(path.join(hostRoot, "opt"), { recursive: true });
await fs.writeFile(path.join(hostRoot, "home", "user", "readme.txt"), "hello\nworld\n");
await fs.writeFile(path.join(hostRoot, "home", "user", ".env"), "SECRET=leaked");
await fs.writeFile(path.join(hostRoot, "home", "user", "config.json"), '{"key":"value"}');
await fs.writeFile(path.join(hostRoot, "etc", "shadow"), "root:hash:12345");
await fs.writeFile(path.join(hostRoot, "etc", "hosts"), "127.0.0.1 localhost");

test.after(() => fs.rm(root, { recursive: true, force: true }));

test("home directory inside allowed root is readable", async () => {
  const result = await listDirectory(hostRoot, "/home/user");
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.some((e) => e.name === "readme.txt"));
});

test("system directories outside allowed roots are rejected", async () => {
  await assert.rejects(() => listDirectory(hostRoot, "/sys"), /restricted/);
  await assert.rejects(() => listDirectory(hostRoot, "/proc"), /restricted/);
  await assert.rejects(() => listDirectory(hostRoot, "/dev"), /restricted/);
  await assert.rejects(() => listDirectory(hostRoot, "/var/lib/docker"), /restricted/);
});

test(".env files inside allowed root are blocked", async () => {
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/.env"), /restricted/);
});

test(".ssh directories are blocked", async () => {
  await assert.rejects(() => listDirectory(hostRoot, "/home/user/.ssh"), /restricted/);
});

test("id_rsa / authorized_keys / known_hosts patterns are blocked", async () => {
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/.ssh/id_rsa"), /restricted/);
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/authorized_keys"), /restricted/);
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/known_hosts"), /restricted/);
});

test(".git directory is blocked", async () => {
  await assert.rejects(() => listDirectory(hostRoot, "/home/user/.git"), /restricted/);
});

test("git HEAD file is blocked", async () => {
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/.git/HEAD"), /restricted/);
});

test("package-lock.json is blocked", async () => {
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/package-lock.json"), /restricted/);
});

test("path traversal via .. is blocked", async () => {
  await assert.rejects(() => listDirectory(hostRoot, "/home/user/../../../etc"), /traversal/);
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/../../etc/shadow"), /traversal/);
});

test("null bytes in path are blocked", async () => {
  await assert.rejects(() => listDirectory(hostRoot, "/home/user\0/etc"), /invalid/);
});

test("symlink inside allowed root pointing to /etc/shadow is blocked", async () => {
  await fs.symlink(path.join(hostRoot, "etc", "shadow"), path.join(hostRoot, "home", "user", "evil-link"));
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/evil-link"), /Symlinks/);
  await fs.unlink(path.join(hostRoot, "home", "user", "evil-link"));
});

test("symlink pointing outside allowed root is blocked by symlink check", async () => {
  await fs.symlink("/etc/passwd", path.join(hostRoot, "home", "user", "outside-link"));
  await assert.rejects(() => viewFileContent(hostRoot, "/home/user/outside-link"), /Symlinks/);
  await fs.unlink(path.join(hostRoot, "home", "user", "outside-link"));
});

test("normal config files inside allowed root pass the check", async () => {
  const result = await viewFileContent(hostRoot, "/home/user/config.json");
  assert.ok(result.text.includes("key"));
  assert.ok(result.text.includes("value"));
});

test("tree resolves only directories inside allowed root", async () => {
  const tree = await getDirectoryTree(hostRoot, "/home");
  assert.ok(tree.children.length > 0);
  await assert.rejects(() => getDirectoryTree(hostRoot, "/sys"), /restricted/);
  await assert.rejects(() => getDirectoryTree(hostRoot, "/proc"), /restricted/);
  await assert.rejects(() => getDirectoryTree(hostRoot, "/var/lib/docker"), /restricted/);
});
