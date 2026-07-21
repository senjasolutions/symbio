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
import { models } from "../db/index.js";

/** Available theme color schemes for the UI. Stored as a server-wide setting. */
export const THEME_CHOICES = [
  { code: "blue", label: "Blue" },
  { code: "red", label: "Red" },
  { code: "green", label: "Green" },
];

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

  // Read server-wide theme from settings (default 'blue')
  let theme = "blue";
  try {
    const themeRow = await models.Setting.findByPk("theme");
    if (themeRow) theme = themeRow.value || "blue";
  } catch (e) { console.error("Failed to load theme setting:", e.message); }

  // Detect HTTPS and localhost for the unencrypted warning banner
  let isHttps = false;
  let isLocalhost = false;
  let httpsReady = false;
  try {
    const proto = context.req.header("x-forwarded-proto") || "";
    isHttps = proto === "https" || String(context.req.url).startsWith("https");
    const host = context.req.header("host") || "";
    isLocalhost = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
    const httpsStatusRow = await models.Setting.findByPk("https_status");
    if (httpsStatusRow?.value) {
      const parsed = JSON.parse(httpsStatusRow.value);
      httpsReady = parsed.enabled === true;
    }
  } catch (e) { /* non-fatal — warning stays visible */ }

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
  let pendingActionCount = 0;
  if (auth) {
    try {     pendingActionCount = await models.SkillAction.count({ where: { status: "pending" } });
  } catch (e) { console.error("Failed to count pending actions:", e.message); }
  }
  const pathName = context.req.path;
  const pageData = { ...data, csrfToken: auth?.session?.csrfToken, t: tLambda, locale, pendingActionCount, currentPath: pathName };
  const body = Mustache.render(pageTemplate, pageData);
  // Navigation state is derived from the request path so every SSR response
  // remains correct without client-side routing or a separate page registry.
  const navigation = {
    dashboardActive: pathName === "/dashboard",
    alertsActive: pathName.startsWith("/alerts"),
    commandCenterActive: pathName.startsWith("/ai/command-center"),
    actionsActive: pathName.startsWith("/ai/actions"),
    aiHistoryActive: pathName === "/ai" || pathName.startsWith("/ai/history"),
    aiUsageActive: pathName.startsWith("/ai/usage"),
    serversActive: pathName.startsWith("/servers"),
    applicationsActive: pathName.startsWith("/applications"),
    tagsActive: pathName.startsWith("/application-tags"),
    installationActive: pathName === "/installation-status",
    settingsActive: pathName === "/settings",
    setupWizardActive: pathName === "/setup-wizard",
  };
  // Standalone mode renders without sidebar/topbar (used by setup wizard)
  const isStandalone = options.standalone === true;
  const html = Mustache.render(baseTemplate, {
    title,
    body,
    authenticated: !isStandalone && Boolean(auth),
    standalone: isStandalone,
    userDisplayName: auth?.user?.displayName,
    csrfToken: auth?.session?.csrfToken,
    insecureHttp: !config.cookieSecure,
    isHttps, isLocalhost, httpsReady,
    showHttpWarning: !config.cookieSecure && !isHttps && !isLocalhost && httpsReady !== true,
    t: tLambda,
    locale,
    languageChoices: LANGUAGE_CHOICES,
    pendingActionCount,
    theme,
    currentPath: pathName,
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
