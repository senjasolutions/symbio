/** SVG chart helpers aggregate bounded histories without a browser chart dependency. */

/** Selects the supported range and bucketing interval from a query value. */
export const chartRange = (value) => value === "7d"
  ? { key: "7d", label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 }
  : { key: "24h", label: "24 hours", milliseconds: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };

/** Averages numeric samples into stable time buckets for small server-rendered charts. */
export const bucketSeries = (rows, valueKey, range, timeKey = "observedAt") => {
  const buckets = new Map();
  for (const row of rows) {
    const value = Number(row[valueKey]);
    const timestamp = new Date(row[timeKey]).getTime();
    if (!Number.isFinite(value) || !Number.isFinite(timestamp)) continue;
    const bucket = Math.floor(timestamp / range.bucketMs) * range.bucketMs;
    const entry = buckets.get(bucket) || { total: 0, count: 0 };
    entry.total += value; entry.count += 1; buckets.set(bucket, entry);
  }
  return Array.from(buckets.entries()).sort(([left], [right]) => left - right).map(([time, entry]) => ({ time, value: entry.total / entry.count }));
};

/** Escapes static chart labels because charts are inserted as server-rendered SVG markup. */
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

/** Renders a labelled axis chart; the first series is intentionally visually dominant. */
export const renderLineChart = (series, label, unit = "%", options = {}) => {
  // Preserve the original single-series helper contract for existing callers and tests.
  if (Array.isArray(series) && series.length && Object.hasOwn(series[0], "value")) series = [{ name: label, points: series }];
  const populated = series.filter((entry) => entry.points.length > 1);
  if (!populated.length) return `<p class="text-secondary mb-0">Not enough data for ${escape(label)}.</p>`;
  const width = 720; const height = 250; const left = 58; const right = 18; const top = 18; const bottom = 42;
  const allPoints = populated.flatMap((entry) => entry.points);
  // Utilization is a fixed scale: operators can compare CPU, RAM, and disk charts directly.
  const minimum = options.min ?? (unit === "%" ? 0 : Math.min(...allPoints.map((point) => point.value), 0));
  const maximum = options.max ?? (unit === "%" ? 100 : Math.max(...allPoints.map((point) => point.value), 1));
  const span = maximum - minimum || 1;
  const firstTime = Math.min(...allPoints.map((point) => point.time));
  const lastTime = Math.max(...allPoints.map((point) => point.time));
  const x = (time) => left + ((time - firstTime) / Math.max(lastTime - firstTime, 1)) * (width - left - right);
  const y = (value) => height - bottom - ((value - minimum) / span) * (height - top - bottom);
  const pathFor = (points) => points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const xTimes = [firstTime, firstTime + (lastTime - firstTime) / 2, lastTime];
  const yValues = [minimum, minimum + span / 2, maximum];
  const timeLabel = (time) => new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const axes = `<path class="chart-axis" d="M${left},${top}V${height - bottom}H${width - right}" />${yValues.map((value) => `<text class="chart-label" x="${left - 6}" y="${y(value) + 4}" text-anchor="end">${value.toFixed(2)}${escape(unit)}</text><path class="chart-grid" d="M${left},${y(value)}H${width - right}" />`).join("")}${xTimes.map((time) => `<text class="chart-label" x="${x(time)}" y="${height - 16}" text-anchor="middle">${escape(timeLabel(time))}</text>`).join("")}`;
  const lines = populated.map((entry, index) => `<path class="${index === 0 ? "chart-line chart-line-primary" : "chart-line chart-line-muted"}" d="${pathFor(entry.points)}" />`).join("");
  const legend = populated.map((entry, index) => `<span class="chart-legend-${index === 0 ? "primary" : "muted"}">${escape(entry.name)}</span>`).join(" ");
  return `<figure class="symbio-chart"><figcaption>${escape(label)} <small>${legend}</small></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)} trend with labelled axes">${axes}${lines}</svg></figure>`;
};
