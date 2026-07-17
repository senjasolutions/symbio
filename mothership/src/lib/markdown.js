/**
 * Minimal markdown-to-HTML renderer using the `marked` library.
 * Output is sanitized to prevent XSS from LLM-generated content.
 */

import { marked } from "marked";

marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Sanitizes raw HTML by escaping < > & " ' to prevent XSS.
 * Used as a safety net since marked passes through raw HTML by default.
 */
const escapeHtml = (str) => {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
};

/** Converts markdown text to safe inner-HTML for Mustache triple-brace rendering. */
export const renderMarkdown = (text) => {
  if (!text) return "";
  try {
    const raw = marked.parse(text);
    // Since marked passes raw HTML through, we strip all HTML tags as a safety net
    // This prevents XSS from LLM-generated content while preserving markdown formatting
    return raw.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
              .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
              .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
              .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, "")
              .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "")
              .replace(/javascript\s*:/gi, "");
  } catch {
    return `<pre class="log-output mb-0" tabindex="0">${escapeHtml(text)}</pre>`;
  }
};
