/**
 * i18n translation module with Mustache section lambda support.
 *
 * Server-side:  t("key")        → plain string
 * Template:     {{#t}}key{{/t}}  → Mustache lambda, supports {{variable}} interpolation
 *
 * Locale JSON files live in mothership/src/i18n/{locale}.json.
 * Fallback chain: requested locale → en → raw key.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const cache = new Map();

/** Reads a locale JSON file from disk and caches it in production. */
const loadLocaleFile = async (locale) => {
  if (config.nodeEnv === "production" && cache.has(locale)) return cache.get(locale);
  try {
    const filePath = path.join(config.viewsPath, "..", "i18n", `${locale}.json`);
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);
    if (config.nodeEnv === "production") cache.set(locale, data);
    return data;
  } catch {
    // Fall back to English if the locale file is missing
    if (locale !== "en") return loadLocaleFile("en");
    return {};
  }
};

/**
 * Creates an i18n context for a single render cycle.
 *
 * Returns:
 *   t(key)     – server-side translation
 *   tLambda    – Mustache section lambda for {{#t}}key{{/t}}
 *   locale     – the active locale code
 */
export const createI18n = async (locale) => {
  const resolvedLocale = locale || "en";
  const [current, fallback] = await Promise.all([
    loadLocaleFile(resolvedLocale),
    resolvedLocale !== "en" ? loadLocaleFile("en") : Promise.resolve({}),
  ]);

  const lookup = (key) => current[key] || fallback[key] || key;

  /**
   * Server-side translation with optional variable interpolation.
   * Usage: t("greeting", { name: "World" }) → "Hello World"
   */
  const t = (key, data) => {
    let value = lookup(key);
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        value = value.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v));
      }
    }
    return value;
  };

  /**
   * Mustache section lambda for templates: {{#t}}key{{/t}}
   * The lambda receives the key text between the tags and a render callback.
   * Translations can contain {{variable}} placeholders resolved from the
   * template's current context via the render() call.
   */
  const tLambda = () => (text, render) => {
    const translation = lookup(text.trim());
    return render(translation);
  };

  return { t, tLambda, locale: resolvedLocale };
};

/** Predefined language choices for UI selectors. */
export const LANGUAGE_CHOICES = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "su", label: "Basa Sunda" },
];
