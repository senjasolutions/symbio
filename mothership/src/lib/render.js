/**
 * Mustache rendering keeps the UI server-first and caches templates in production.
 * i18n context (t lambda + locale) is injected per-request based on the
 * authenticated user's language preference, falling back to English.
 */

import fs from "node:fs/promises";
import path from "node:path";
import Mustache from "mustache";
import { config } from "../config.js";
import { createI18n } from "./i18n.js";
import { LANGUAGE_CHOICES } from "./i18n.js";

const cache = new Map();

/** Reads a template from the approved views directory and caches production reads. */
const readTemplate = async (name) => {
  if (config.nodeEnv === "production" && cache.has(name)) return cache.get(name);
  const template = await fs.readFile(path.join(config.viewsPath, `${name}.mustache`), "utf8");
  if (config.nodeEnv === "production") cache.set(name, template);
  return template;
};

/**
 * Renders a page inside the common authenticated or unauthenticated layout.
 * i18n: resolves locale from auth.user.language (defaults to 'en' for guests),
 * injects the Mustache translation lambda {{#t}}key{{/t}} into both passes.
 *
 * Title resolution order:
 *   1. options.titleKey — translated via t()
 *   2. options.title    — used as-is (backward-compatible)
 *   3. pageTitle.{name} — derived from template name
 *   4. pageTitle.symbio — ultimate fallback
 */
export const renderPage = async (context, name, data = {}, options = {}) => {
  const [pageTemplate, baseTemplate] = await Promise.all([readTemplate(name), readTemplate("base")]);
  const auth = context.get("auth");

  // Resolve language per-user (default 'en' for unauthenticated / login pages)
  const locale = auth?.user?.language || "en";
  const { t, tLambda } = await createI18n(locale);

  // Derive the page title from the most specific source available
  let title;
  if (options.titleKey) {
    title = t(options.titleKey);
  } else if (options.title) {
    title = options.title;
  } else {
    // Try pageTitle.{templateName} (e.g. pageTitle.dashboard), fall back to generic
    title = t(`pageTitle.${name}`) === `pageTitle.${name}` ? t("pageTitle.symbio") : t(`pageTitle.${name}`);
  }

  // Page forms need the synchronizer token during the first render; the base
  // layout is rendered afterward and cannot interpolate inside rendered HTML.
  const pageData = { ...data, csrfToken: auth?.session?.csrfToken, t: tLambda, locale };
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
    title,
    body,
    authenticated: Boolean(auth),
    userDisplayName: auth?.user?.displayName,
    csrfToken: auth?.session?.csrfToken,
    insecureHttp: !config.cookieSecure,
    t: tLambda,
    locale,
    languageChoices: LANGUAGE_CHOICES,
    ...navigation,
  });
  return context.html(html);
};

/** Resolves user locale and creates i18n context for server-side use in route handlers. */
export const resolveI18n = async (context) => {
  const auth = context.get("auth");
  const locale = auth?.user?.language || "en";
  return createI18n(locale);
};
