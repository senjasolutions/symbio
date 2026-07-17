/**
 * Notification channel registry — dispatches alert events to all enabled channels.
 * Modular by design: add new channel types (discord, email, webhook, etc.) by
 * creating a sender module and registering it here.
 */

import { models } from "../../db/index.js";
import { sendSlackNotification } from "./slack.js";

/** Maps channel type to its sender function. Each sender receives (channel, params). */
const SENDERS = {
  slack: sendSlackNotification,
};

/** Dispatches a notification to all channels referenced by a rule's notify_channels JSON array. */
export const dispatchAlert = async (rule, params) => {
  let channelIds = [];
  try { channelIds = JSON.parse(rule.notifyChannels || "[]"); } catch { return; }
  if (!channelIds.length) return;

  const channels = await models.NotificationChannel.findAll({
    where: { id: channelIds, enabled: true },
  });

  for (const channel of channels) {
    const sender = SENDERS[channel.type];
    if (!sender) continue;
    try { await sender(channel, params); } catch {}
  }
};

/** Sends a test notification to verify a channel configuration. */
export const testChannel = async (channel) => {
  const sender = SENDERS[channel.type];
  if (!sender) return { ok: false, error: `Unknown channel type: ${channel.type}` };

  return sender(channel, {
    eventType: "test",
    ruleName: "Test Notification",
    resource: "test",
    metricField: "test",
    metricValue: 0,
    thresholdValue: 0,
    operator: "gt",
    hostname: "symbio-test",
    triggeredAt: new Date().toISOString(),
  });
};
