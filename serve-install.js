#!/usr/bin/env node
/**
 * Minimal HTTP server that serves install.sh and source.tar.gz for remote install.
 *
 * install.sh is served with SOURCE_SERVER injected so remote clients know
 * where to download the full source tree from.
 *
 * Usage:  node serve-install.js
 *         PORT=9999 node serve-install.js
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");

const PORT = process.env.PORT || 9999;
const DIR = __dirname;

const ip = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i.family === "IPv4" && !i.internal)
  ?.address || "127.0.0.1";
const SOURCE_SERVER = `http://${ip}:${PORT}`;

// Read install.sh and inject SOURCE_SERVER after the shebang
const rawScript = fs.readFileSync(path.join(DIR, "install.sh"), "utf8");
const lines = rawScript.split("\n");
// lines[0] = "#!/bin/sh" — inject after it
lines.splice(1, 0, `SOURCE_SERVER="${SOURCE_SERVER}"`);
const servedScript = lines.join("\n");
const scriptBuf = Buffer.from(servedScript, "utf8");

// Cache the tarball so repeated requests don't re-tar
let tarballCache = null;

const generateTarball = () => {
  if (tarballCache) return tarballCache;
  const excludes = [
    "--exclude=.git", "--exclude=node_modules", "--exclude=*/node_modules",
    "--exclude=.symbio", "--exclude=.env", "--exclude=*.sqlite*",
    "--exclude=install.log",
  ];
  const cmd = `tar ${excludes.join(" ")} -czf - -C "${DIR}" .`;
  tarballCache = execSync(cmd, { maxBuffer: 100 * 1024 * 1024 });
  return tarballCache;
};

http.createServer((req, res) => {
  if (req.url === "/install.sh") {
    res.writeHead(200, {
      "Content-Type": "text/x-shellscript",
      "Content-Length": scriptBuf.length,
    });
    res.end(scriptBuf);
  } else if (req.url === "/source.tar.gz") {
    try {
      const data = generateTarball();
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": data.length,
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500).end("Failed to generate tarball: " + e.message + "\n");
    }
  } else {
    res.writeHead(404).end("Available: /install.sh  /source.tar.gz\n");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  Symbio install server running");
  console.log("");
  console.log(`    curl -fsSL http://${ip}:${PORT}/install.sh | bash`);
  console.log("");
});
