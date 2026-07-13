/** Hono application factories keep public dashboard and private agent traffic isolated. */

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import { securityHeaders } from "./lib/security.js";
import { internalRoutes } from "./routes/internal.js";
import { webRoutes } from "./routes/web.js";

/** Creates the public SSR dashboard with only static assets and a shallow health endpoint unauthenticated. */
export const createPublicApp = () => {
  const app = new Hono();
  app.use("*", securityHeaders);
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (context) => context.text("Request body is too large.", 413) }));
  app.get("/healthz", (context) => context.json({ service: "symbio-mothership", status: "ok" }));
  // Public filenames are intentionally fixed; exact mappings prevent Hono
  // from incorrectly looking for a non-existent public/assets directory.
  app.get("/assets/styles.css", serveStatic({ path: "./public/styles.css" }));
  app.get("/assets/app.js", serveStatic({ path: "./public/app.js" }));
  app.get("/assets/file-manager.js", serveStatic({ path: "./public/file-manager.js" }));
  app.get("/vendor/bootstrap.min.css", serveStatic({ path: "./node_modules/bootstrap/dist/css/bootstrap.min.css" }));
  // Package files stay local to the image; no CDN is needed for icons or tag entry.
  app.use("/vendor/fontawesome/*", serveStatic({ root: "./node_modules/@fortawesome/fontawesome-free", rewriteRequestPath: (path) => path.replace(/^\/vendor\/fontawesome\//, "/") }));
  app.get("/vendor/tagify.js", serveStatic({ path: "./node_modules/@yaireo/tagify/dist/tagify.js" }));
  app.get("/vendor/tagify.css", serveStatic({ path: "./node_modules/@yaireo/tagify/dist/tagify.css" }));
  app.route("/", webRoutes);
  app.notFound((context) => context.text("Not found", 404));
  app.onError((error, context) => {
    console.error("Public request failed:", error.message);
    return context.text("Internal server error", 500);
  });
  return app;
};

/** Creates the token-protected private app used only by the local agent. */
export const createInternalApp = () => {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: (context) => context.json({ ok: false, error: "Report body is too large" }, 413) }));
  app.get("/healthz", (context) => context.json({ service: "symbio-mothership-internal", status: "ok" }));
  app.route("/internal/v1", internalRoutes);
  app.onError((error, context) => {
    console.error("Internal agent request failed:", error.message);
    return context.json({ ok: false, error: "Internal server error" }, 500);
  });
  return app;
};
