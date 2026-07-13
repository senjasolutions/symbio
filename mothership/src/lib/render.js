/** Mustache rendering keeps the UI server-first and caches templates in production. */

import fs from "node:fs/promises";
import path from "node:path";
import Mustache from "mustache";
import { config } from "../config.js";

const cache = new Map();

/** Reads a template from the approved views directory and caches production reads. */
const readTemplate = async (name) => {
  if (config.nodeEnv === "production" && cache.has(name)) return cache.get(name);
  const template = await fs.readFile(path.join(config.viewsPath, `${name}.mustache`), "utf8");
  if (config.nodeEnv === "production") cache.set(name, template);
  return template;
};

/** Renders a page inside the common authenticated or unauthenticated layout. */
export const renderPage = async (context, name, data = {}, options = {}) => {
  const [pageTemplate, baseTemplate] = await Promise.all([readTemplate(name), readTemplate("base")]);
  const auth = context.get("auth");
  // Page forms need the synchronizer token during the first render; the base
  // layout is rendered afterward and cannot interpolate inside rendered HTML.
  const pageData = { ...data, csrfToken: auth?.session?.csrfToken };
  const body = Mustache.render(pageTemplate, pageData);
  const pathName = context.req.path;
  // Navigation state is derived from the request path so every SSR response
  // remains correct without client-side routing or a separate page registry.
  const navigation = {
    dashboardActive: pathName === "/dashboard",
    serversActive: pathName.startsWith("/servers"),
    applicationsActive: pathName.startsWith("/applications"),
    tagsActive: pathName.startsWith("/application-tags"),
    installationActive: pathName === "/installation-status",
    settingsActive: pathName === "/settings",
  };
  const html = Mustache.render(baseTemplate, {
    title: options.title || "Symbio",
    body,
    authenticated: Boolean(auth),
    userDisplayName: auth?.user?.displayName,
    csrfToken: auth?.session?.csrfToken,
    insecureHttp: !config.cookieSecure,
    ...navigation,
  });
  return context.html(html);
};
