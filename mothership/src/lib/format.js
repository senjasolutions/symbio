/** Shared presentation helpers keep SSR pages and progressive refreshes consistent. */

/** Formats every percentage to exactly two decimal places, or an explicit unavailable mark. */
export const formatPercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "—";
};

/** Formats byte values with two decimals after the byte unit for comparable operational readings. */
export const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

/** Formats host uptime without inventing smaller-than-second precision. */
export const formatUptime = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
};

/** Averages valid numeric samples for the compact rolling metric summaries. */
export const rollingAverage = (rows, field, milliseconds) => {
  const cutoff = Date.now() - milliseconds;
  const values = rows.filter((row) => new Date(row.observedAt).getTime() >= cutoff).map((row) => Number(row[field])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
};
