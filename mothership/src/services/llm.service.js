/**
 * LLM service — abstracts OpenAI-compatible (DeepSeek, OpenAI) and Anthropic APIs
 * behind a single askAI() function. The primary target is DeepSeek, but the same
 * code path works for OpenAI. Anthropic uses a separate format handler.
 */

import { models } from "../db/index.js";

/**
 * Provider-specific defaults and model lists.
 * Used by the settings page to populate the model dropdown and by the service as fallback endpoints.
 */
export const PROVIDER_MODELS = {
  deepseek:  ["deepseek-v4-flash", "deepseek-v4-pro"],
  openai:    ["gpt-5.6 (default openai)", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

const PROVIDER_DEFAULTS = {
  deepseek:  { endpoint: "https://api.deepseek.com" },
  openai:    { endpoint: "https://api.openai.com/v1" },
  anthropic: { endpoint: "https://api.anthropic.com/v1" },
};

/**
 * Strips markdown code fences and common JSON wrappers from LLM output.
 * Many LLMs wrap JSON in ```json ... ``` fences which breaks JSON.parse().
 */
const extractJson = (content) => {
  let text = (content || "").trim();
  // Strip ```json ... ``` fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Strip ``` ... ``` generic fences
  text = text.replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  // Strip leading/trailing whitespace
  text = text.trim();
  return text;
};

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

/** Fetches with retry for transient failures (429, 503, network errors). */
const fetchWithRetry = async (url, options, attempt = 0) => {
  try {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status === 503) {
      throw { retryable: true, status: response.status };
    }
    return response;
  } catch (error) {
    if (error.retryable && attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return fetchWithRetry(url, options, attempt + 1);
    }
    // Network errors are also retryable
    if (error.type === "system" && attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw error;
  }
};

/**
 * Builds the system prompt used for log analysis.
 * Gives a professional, safety-conscious persona and asks for Markdown formatting.
 */
export const buildSystemPrompt = () => [
  "You are an elite professional Linux server administrator and DevOps engineer at a top global technology company.",
  "Analyze the provided server context and logs, then answer the user's question.",
  "",
  "Guidelines:",
  "- Be specific about what the logs indicate. If you see error patterns, explain their likely cause.",
  "- Suggest concrete, actionable fixes with the actual commands or configuration changes needed.",
  "- BE CONSERVATIVE AND SAFE. Never suggest destructive commands (rm -rf, format, dd, fdisk, mkfs, etc.).",
  "- Always explain the risk level (low / medium / high) of any suggested action.",
  "- Prefer non-destructive approaches first (restarting services, configuration changes) before suggesting anything risky.",
  "- If the logs do not contain enough information to answer, say so clearly instead of guessing.",
  "- Format your entire response in Markdown with clear headings (##), code blocks (`), bold (**), and lists.",
  "- Use inline code for file paths, commands, and port numbers.",
  "- Keep responses concise but thorough enough to be actionable.",
  "- Do NOT wrap your response in a Markdown code block or any other wrapper — just output the Markdown directly.",
].join("\n");

/**
 * Max log content length sent to the LLM (roughly 32K tokens worth of text).
 * Server-side cap prevents unbounded upstream costs.
 */
const MAX_LOG_CHARS = 48_000;

/** Maps personality names to system prompt instructions. */
const PERSONALITY_INSTRUCTIONS = {
  professional: "Be professional and formal in tone.",
  friendly: "Be friendly and approachable. Use casual language.",
  concise: "Be very brief and to the point. Use bullet points where helpful. Avoid long explanations.",
  technical: "Be highly technical and detailed. Include exact commands and configuration syntax.",
  educational: "Explain concepts clearly and thoroughly. Include reasoning and background context.",
  satirical: "Use satirical and witty language. Be humorous but still informative and accurate. Do not be offensive.",
};

/**
 * Reads the server_personality setting and returns a formatted context string
 * filtered by injection level. Called by both askAI() and callSkillAI().
 *
 * Level-to-field mapping:
 *   low    → nickname + purpose
 *   medium → low + quirks + specs + provider
 *   high   → everything (incl. location + extra notes)
 */
const buildServerPersonalityContext = async () => {
  try {
    const row = await models.Setting.findByPk("server_personality");
    if (!row?.value) return "";
    const p = JSON.parse(row.value);
    const level = p.injectionLevel || "medium";
    const ctx = [];

    if (!p.nickname?.trim()) return "";
    ctx.push(`- Nickname: ${p.nickname.trim()}`);

    if (p.purpose?.trim()) ctx.push(`- Purpose: ${p.purpose.trim()}`);

    if (level !== "low") {
      if (p.quirks?.trim()) ctx.push(`- Quirks: ${p.quirks.trim()}`);

      if (p.specs?.trim()) ctx.push(`- Specs:\n${p.specs.trim().split("\n").map((l) => `  ${l}`).join("\n")}`);

      if (p.provider?.type && p.provider.type !== "none") {
        const labels = { aws: "AWS", azure: "Azure", gcp: "Google Cloud", hetzner: "Hetzner", digitalocean: "DigitalOcean", linode: "Linode", vultr: "Vultr", ovhcloud: "OVHcloud", scaleway: "Scaleway", self: "Self-Hosted", other: p.provider.otherName || "Other", common: "Common Hosting" };
        ctx.push(`- Provider: ${labels[p.provider.type] || p.provider.type}`);
      }

      if (level === "high") {
        if (p.location?.city || p.location?.country) {
          ctx.push(`- Location: ${[p.location.city, p.location.country, p.location.planet || "Earth"].filter(Boolean).join(", ")}`);
        }
        if (p.extraNotes?.trim()) ctx.push(`- Notes: ${p.extraNotes.trim()}`);
      }
    }

    if (ctx.length <= 1) return ""; // Only nickname → not useful
    return `\n\n## Server Personality Context\n${ctx.join("\n")}`;
  } catch { return ""; }
};

/** Injects language, personality, and custom instruction into a system prompt. */
const buildCustomPrompt = (systemPrompt, options = {}) => {
  const parts = [systemPrompt];
  if (options.language && options.language !== "en") {
    parts.push(`The user's preferred language is ${options.language}. Respond entirely in that language unless the user asks otherwise.`);
  }
  if (options.personality && options.personality !== "default" && PERSONALITY_INSTRUCTIONS[options.personality]) {
    parts.push(PERSONALITY_INSTRUCTIONS[options.personality]);
  }
  if (options.customInstruction) {
    parts.push(`Additional instruction from the user:\n${options.customInstruction}`);
  }
  return parts.join("\n\n");
};

/**
 * Calls the LLM API for one of the three supported providers.
 *
 * @param {object} options
 * @param {string} options.provider - "deepseek" | "openai" | "anthropic"
 * @param {string} options.apiKey   - Secret key from settings
 * @param {string} options.endpoint - Optional custom base URL
 * @param {string} options.model    - Model name (e.g. "deepseek-v4-flash")
 * @param {string} options.logContent - The log text to analyze
 * @param {string} options.question - The user's question about the logs
 * @param {boolean} options.thinkingEnabled - Enable DeepSeek thinking mode (ignored for others)
 * @param {string}  options.reasoningEffort - "high" | "max" (DeepSeek thinking only)
 * @returns {{ content: string, reasoningContent: string|null, error: string|null }}
 */
export const askAI = async ({ provider, apiKey, endpoint, model, logContent, question, thinkingEnabled, reasoningEffort, language, personality, customInstruction }) => {
  if (!provider || !apiKey) return { content: null, reasoningContent: null, usage: null, error: "LLM is not configured. Go to Settings > LLM Integration to set up an API key." };
  if (!question || question.length > 1000) return { content: null, reasoningContent: null, usage: null, error: "Question must be between 1\u20131000 characters." };

  const baseEndpoint = (endpoint || PROVIDER_DEFAULTS[provider]?.endpoint || "").replace(/\/+$/, "");
  if (!baseEndpoint) return { content: null, reasoningContent: null, error: `Unknown provider "${provider}".` };

  const personalityCtx = await buildServerPersonalityContext();
  const systemPrompt = buildCustomPrompt(buildSystemPrompt() + personalityCtx, { language, personality, customInstruction });
  const userContent = `Here are the server logs:\n\n${(logContent || "").slice(0, MAX_LOG_CHARS)}\n\nQuestion: ${question}`;

  try {
    if (provider === "anthropic") {
      return await callAnthropic({ baseEndpoint, apiKey, model, systemPrompt, userContent });
    }
    return await callOpenAICompatible({ baseEndpoint, apiKey, model, systemPrompt, userContent, thinkingEnabled, reasoningEffort, provider });
  } catch (error) {
    return { content: null, reasoningContent: null, usage: null, error: error.message };
  }
};

/**
 * Calls any provider using the OpenAI-compatible /chat/completions format.
 * DeepSeek, OpenAI, and custom OpenAI-compatible endpoints all use this path.
 */
const callOpenAICompatible = async ({ baseEndpoint, apiKey, model, systemPrompt, userContent, thinkingEnabled, reasoningEffort, provider }) => {
  const body = {
    model: model || PROVIDER_MODELS[provider]?.[0] || "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: 4096,
  };

  // Only DeepSeek supports the thinking / reasoning_effort parameters
  if (provider === "deepseek" && thinkingEnabled) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = reasoningEffort || "high";
  }

  const response = await fetchWithRetry(`${baseEndpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `API returned status ${response.status}.`);
  }

  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("API response did not contain a completion.");

  const usage = data.usage ? {
    promptTokens: data.usage.prompt_tokens || 0,
    completionTokens: data.usage.completion_tokens || 0,
    totalTokens: data.usage.total_tokens || 0,
  } : null;

  return { content: msg.content || "", reasoningContent: msg.reasoning_content || null, usage, error: null };
};

/**
 * Calls the Anthropic Messages API (different auth header, body structure, and response format).
 * Thinking mode is not yet fully integrated — basic Anthropic chat works without it.
 */
const callAnthropic = async ({ baseEndpoint, apiKey, model, systemPrompt, userContent }) => {
  const body = {
    model: model || PROVIDER_MODELS.anthropic[0],
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    max_tokens: 4096,
  };

  const response = await fetchWithRetry(`${baseEndpoint}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic API returned status ${response.status}.`);
  }

  const textBlock = data.content?.find((b) => b.type === "text");
  const thinkingBlock = data.content?.find((b) => b.type === "thinking");

  const usage = data.usage ? {
    promptTokens: data.usage.input_tokens || 0,
    completionTokens: data.usage.output_tokens || 0,
    totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
  } : null;

  return {
    content: textBlock?.text || "",
    reasoningContent: thinkingBlock?.thinking || null,
    usage, error: null,
  };
};

/**
 * Fetches the DeepSeek account balance from the user balance endpoint.
 * @param {string} apiKey - The DeepSeek API secret key.
 * @returns {{ balanceInfos: Array<{ currency: string, totalBalance: string }>, isAvailable: boolean }}
 */
export const checkBalance = async (apiKey) => {
  const response = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Balance check returned status ${response.status}.`);
  return data;
};

/**
 * Builds the system context string sent to the LLM for application discovery.
 * Filters processes to only the most relevant ones (listening/watching port-based).
 */
export const buildDiscoveryContext = (processes, ports, packages) => {
  // Find PIDs that own listening ports
  const listeningPids = new Set(ports.filter((p) => p.pid).map((p) => p.pid));
  const relevantProcs = processes.filter((p) => listeningPids.has(p.pid) || /node|python|php|java|ruby|go|nginx|apache|httpd|gunicorn|uwsgi|daphne|unicorn|passenger|dotnet/i.test(p.command));
  const procLines = relevantProcs.slice(0, 60).map((p) => `  ${p.pid}  ${(p.command || "").slice(0, 120)}`).join("\n");
  const portLines = ports.map((p) => `  ${p.localPort}  ${p.protocol}  ${p.processName || "?"}`).join("\n");
  const pkgNames = packages.filter((p) => /nginx|apache|httpd|node|python|php|java|ruby|go|gunicorn|uwsgi|mysql|postgres|mongo|redis|elastic|caddy|tomcat|jetty|jboss|wildfly|dotnet|docker/i.test(p.name)).map((p) => p.name).sort();
  return ["=== LISTENING PORTS ===", portLines, "=== WEB-RELATED PROCESSES ===", procLines, "=== INSTALLED WEB PACKAGES ===", pkgNames.join("\n")].join("\n");
};

/**
 * Called the LLM to discover web applications running on the server.
 * Uses response_format: json_object for structured output (DeepSeek/OpenAI only).
 */
export const discoverApplications = async ({ provider, apiKey, endpoint, model, systemInfo }) => {
  if (!provider || !apiKey) return { applications: [], rawResponse: "", usage: null, error: "LLM is not configured." };
  if (provider === "anthropic") return { applications: [], rawResponse: "", usage: null, error: "Application discovery requires DeepSeek or OpenAI. Switch your provider in Settings > LLM Integration." };

  const baseEndpoint = (endpoint || PROVIDER_DEFAULTS[provider]?.endpoint || "").replace(/\/+$/, "");
  if (!baseEndpoint) return { applications: [], rawResponse: "", usage: null, error: `Unknown provider "${provider}".` };

  const systemPrompt = [
    "You are a server administrator analyzing a Linux server to discover web applications and services.",
    "Based on the running processes, listening ports, and installed packages below, identify every web application, API, or service running on this server.",
    "",
    'For each application found, return an object with:',
    '- "name": lowercase slug (3-63 chars, only a-z, 0-9, underscore, hyphen, must start with letter or number)',
    '- "displayName": human-readable name for display (max 120 chars)',
    '- "healthCheckUrl": the URL to health-check this app, use http://localhost:PORT if the port is known, http://localhost if not',
    '- "directory": the most likely root directory on disk (best guess)',
    '- "logPaths": an array of suggested log file paths',
    '- "type": technology: "node", "php", "python", "nginx", "apache", "static", "go", "docker", "java", "ruby", or "other"',
    "",
    "Rules:",
    "- Do NOT include system services like SSH, cron, systemd-logind, etc. Only web applications and services that serve HTTP.",
    "- If you are not confident about a field, use an empty string or empty array.",
    "- Return ONLY valid JSON in the following format, no other text:",
    '{ "applications": [ { "name": "...", "displayName": "...", "healthCheckUrl": "...", "directory": "...", "logPaths": ["..."], "type": "..." } ] }',
  ].join("\n");

  const userContent = `Analyze this server data:\n\n${(systemInfo || "").slice(0, MAX_LOG_CHARS)}`;
  const body = {
    model: model || PROVIDER_MODELS[provider]?.[0] || "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    max_tokens: 4096,
  };

  try {
    const response = await fetchWithRetry(`${baseEndpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `API returned status ${response.status}.`);
    const msg = data.choices?.[0]?.message;
    if (!msg?.content) throw new Error("API response did not contain a completion.");
    const usage = data.usage ? { promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0, totalTokens: data.usage.total_tokens || 0 } : null;
    let applications = [];
    try { const parsed = JSON.parse(extractJson(msg.content)); applications = Array.isArray(parsed.applications) ? parsed.applications : []; } catch { /* keep empty */ }
    return { applications, rawResponse: msg.content, usage, error: null };
  } catch (error) {
    return { applications: [], rawResponse: "", usage: null, error: error.message };
  }
};

/**
 * Calls the LLM with a skill-specific system prompt and structured data.
 * Uses JSON output format for structured responses (DeepSeek/OpenAI only).
 * Handles markdown-wrapped JSON and truncated responses gracefully.
 */
export const callSkillAI = async ({ provider, apiKey, endpoint, model, systemPrompt, dataContent, maxTokens, language, personality, customInstruction }) => {
  if (!provider || !apiKey) return { content: null, usage: null, error: "LLM is not configured." };
  if (provider === "anthropic") return { content: null, usage: null, error: "Anthropic does not support structured JSON output required for skills." };

  const baseEndpoint = (endpoint || PROVIDER_DEFAULTS[provider]?.endpoint || "").replace(/\/+$/, "");
  if (!baseEndpoint) return { content: null, usage: null, error: `Unknown provider "${provider}".` };

  const personalityCtx = await buildServerPersonalityContext();
  const enhancedSystemPrompt = buildCustomPrompt(systemPrompt + personalityCtx, { language, personality, customInstruction });

  const body = {
    model: model || PROVIDER_MODELS[provider]?.[0] || "deepseek-v4-flash",
    messages: [
      { role: "system", content: enhancedSystemPrompt },
      { role: "user", content: (dataContent || "").slice(0, MAX_LOG_CHARS) },
    ],
    response_format: { type: "json_object" },
    max_tokens: maxTokens || 2048,
  };

  try {
    const response = await fetchWithRetry(`${baseEndpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `API returned status ${response.status}.`);
    const msg = data.choices?.[0]?.message;
    if (!msg?.content) throw new Error("API response did not contain a completion.");

    // Check for truncation — if finish_reason is "length", the JSON may be incomplete
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === "length") {
      return { content: null, usage: null, error: "LLM response was truncated (max_tokens reached). The analysis may be incomplete. Try increasing the token limit or reducing the data size." };
    }

    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0,
    } : null;

    // Strip markdown fences from response before passing to callers
    const cleaned = extractJson(msg.content);
    return { content: cleaned, usage, error: null, rawResponse: msg.content };
  } catch (error) {
    return { content: null, usage: null, error: error.message };
  }
};
