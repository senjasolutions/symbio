/**
 * Slack incoming-webhook notification sender.
 * Formats alert events as compact Block Kit messages following the monit
 * style: "Resource limit matched" on fire, "Resource limit succeeded" on resolve.
 * Each channel stores its webhook URL in notification_channels.config.
 */

/** Dispatches an alert notification to a Slack incoming webhook. */
export const sendSlackNotification = async (channel, params) => {
  const config = parseConfig(channel.config);
  const webhookUrl = config.webhook_url;
  if (!webhookUrl) return { ok: false, error: "Slack webhook URL not configured." };

  const { eventType, ruleName, resource, metricField, metricValue, thresholdValue, operator, hostname, triggeredAt, diagnostic, statusText, targetName, statusMatch } = params;

  const isFiring = eventType === "firing";
  const title = isFiring ? "Resource limit matched" : "Resource limit succeeded";
  const color = isFiring ? "#dc3545" : "#28a745";

  // Build message line based on resource type
  let line;
  if (resource === "application" || resource === "service") {
    // Status-based: "application my-api status of down matches [status = down]"
    if (isFiring) {
      const statusList = (statusMatch || []).join(" or ");
      line = `${hostname} ${resource} ${targetName || "?"} status of ${statusText || "?"} matches resource limit [status = ${statusList}]`;
    } else {
      line = `${hostname} ${resource} ${targetName || "?"} check succeeded [current status = ${statusText || "up"}]`;
    }
  } else {
    // Numeric threshold
    const opSymbol = operator === "gt" ? ">" : "<";
    if (isFiring) {
      line = `${hostname} ${resourceLabel(resource, metricField)} of ${formatMetric(metricField, metricValue)} matches resource limit [${resourceLabel(resource, metricField)} ${opSymbol} ${formatMetric(metricField, thresholdValue)}]`;
    } else {
      line = `${hostname} ${resourceLabel(resource, metricField)} check succeeded [current ${resourceLabel(resource, metricField)} = ${formatMetric(metricField, metricValue)}]`;
    }
  }

  // Add diagnostic detail if firing and available (numeric resources only)
  let diagBlock = "";
  if (isFiring && diagnostic && resource !== "application" && resource !== "service") {
    const lines = [];
    if (diagnostic.topCpu?.length) {
      lines.push("*Top CPU processes:*");
      for (const p of diagnostic.topCpu) lines.push(`  \`${p.name}\` (PID ${p.pid}) — ${p.command}`);
    }
    if (diagnostic.topMem?.length) {
      lines.push("*Top memory processes:*");
      for (const p of diagnostic.topMem) {
        const mb = (p.rss / 1048576).toFixed(1);
        lines.push(`  \`${p.name}\` (PID ${p.pid}) — ${mb} MB`);
      }
    }
    if (lines.length) diagBlock = "\n" + lines.join("\n");
  }

  const dt = new Date(triggeredAt);
  const dateStr = dt.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  const timeStr = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: line + diagBlock } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Date* ${dateStr}, ${timeStr}` },
        { type: "mrkdwn", text: `*Host* ${hostname}` },
      ],
    },
  ];

  try {
    const body = {
      blocks,
      attachments: [{ color }],
    };
    if (config.slack_channel) body.channel = config.slack_channel;
    if (config.slack_username) body.username = config.slack_username;
    if (config.slack_icon_emoji) body.icon_emoji = config.slack_icon_emoji;

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `Slack returned ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

/** Maps resource+metric to a human label for notification messages. */
const resourceLabel = (resource, field) => {
  const labels = {
    cpu_cpuPercent: "cpu usage",
    cpu_cpuIowaitPercent: "cpu I/O wait",
    memory_memoryPercent: "memory usage",
    swap_swapPercent: "swap usage",
    disk_diskPercent: "disk usage",
    load_load1: "loadavg (1min)",
    load_load5: "loadavg (5min)",
    load_load15: "loadavg (15min)",
    network_networkRxBytesPerSec: "download throughput",
    network_networkTxBytesPerSec: "upload throughput",
  };
  return labels[`${resource}_${field}`] || `${resource} ${field}`;
};

/** Formats a metric value for human display in notification messages. */
const formatMetric = (field, value) => {
  if (field?.includes?.("network")) return `${(Number(value) / 1048576).toFixed(2)} MB/s`;
  if (field?.includes?.("Percent") || field?.includes?.("percent")) return `${value.toFixed(1)}%`;
  if (field?.startsWith?.("load")) return value.toFixed(2);
  return String(value);
};

const parseConfig = (json) => {
  if (json && typeof json === "object") return json;
  try { return JSON.parse(json || "{}"); } catch { return {}; }
};
