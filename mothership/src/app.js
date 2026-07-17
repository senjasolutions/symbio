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
  // Provider logos for AI model display
  app.use("/img/providers/*", serveStatic({ root: "./public/img/providers", rewriteRequestPath: (path) => path.replace(/^\/img\/providers\//, "/") }));
  app.use("/img/*", serveStatic({ root: "./public/img", rewriteRequestPath: (path) => path.replace(/^\/img\//, "/") }));
  app.route("/", webRoutes);
  app.notFound((context) => context.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found — Symbio</title><link href="/vendor/bootstrap.min.css" rel="stylesheet"></head><body class="d-flex align-items-center justify-content-center vh-100"><div class="text-center"><h1 class="display-1 text-secondary">404</h1><p class="lead">Page not found.</p><a class="btn btn-outline-primary" href="/dashboard">Go to Dashboard</a></div></body></html>`, 404));
  app.onError((error, context) => {
    console.error("Public request failed:", error instanceof Error ? error.message : error);
    return context.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error — Symbio</title><link href="/vendor/bootstrap.min.css" rel="stylesheet"></head><body class="d-flex align-items-center justify-content-center vh-100"><div class="text-center"><h1 class="display-1 text-secondary">500</h1><p class="lead">Internal server error.</p><a class="btn btn-outline-primary" href="/dashboard">Go to Dashboard</a></div></body></html>`, 500);
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
