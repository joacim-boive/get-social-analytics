import { asNumber, isRecord, readString } from "../util.js";
import type { SeriesPoint, UnavailableMetric } from "../report/types.js";
import { mapMetaError, PlatformApiError } from "./errors.js";
import { requestJson } from "./http.js";

export const INSTAGRAM_GRAPH = "https://graph.instagram.com/v26.0";
export const FACEBOOK_GRAPH = "https://graph.facebook.com/v26.0";

export type ParsedInsight = {
  name: string;
  totalValue: number | null;
  points: Array<{ date: string; value: number }>;
  breakdowns: Array<{ dimension: string; value: number }>;
};

export async function graphGet(
  host: string,
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${host}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);
  const { status, body } = await requestJson(url.toString());
  if (status >= 400 || (isRecord(body) && isRecord(body.error))) throw mapMetaError(body, status);
  return body;
}

export function parseInsightPayload(body: unknown): ParsedInsight[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const metrics: ParsedInsight[] = [];
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    metrics.push({
      name: entry.name,
      totalValue: readInsightTotal(entry),
      points: readPoints(entry),
      breakdowns: readBreakdowns(entry),
    });
  }
  return metrics;
}

export async function fetchInsightMetrics(args: {
  host: string;
  path: string;
  token: string;
  metrics: string[];
  params: Record<string, string>;
  keyForMetric: (metricName: string) => string;
}): Promise<{ parsed: ParsedInsight[]; unavailable: UnavailableMetric[] }> {
  if (args.metrics.length === 0) return { parsed: [], unavailable: [] };
  try {
    const body = await graphGet(args.host, args.path, args.token, {
      ...args.params,
      metric: args.metrics.join(","),
    });
    return { parsed: parseInsightPayload(body), unavailable: [] };
  } catch (error) {
    if (!(error instanceof PlatformApiError) || error.code !== "invalid_metric") throw error;
    if (args.metrics.length === 1) {
      return {
        parsed: [],
        unavailable: [{ key: args.keyForMetric(args.metrics[0] ?? "metric"), reason: error.message }],
      };
    }
    const parsed: ParsedInsight[] = [];
    const unavailable: UnavailableMetric[] = [];
    for (const metricName of args.metrics) {
      const part = await fetchInsightMetrics({ ...args, metrics: [metricName] });
      parsed.push(...part.parsed);
      unavailable.push(...part.unavailable);
    }
    return { parsed, unavailable };
  }
}

export function insightByName(metrics: ParsedInsight[], name: string): ParsedInsight | null {
  return metrics.find((metric) => metric.name === name) ?? null;
}

export function summedPoints(metric: ParsedInsight | null): number | null {
  if (!metric || metric.points.length === 0) return null;
  return metric.points.reduce((total, point) => total + point.value, 0);
}

export function seriesFromPoints(groups: Array<{ key: string; points: Array<{ date: string; value: number }> }>): SeriesPoint[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const group of groups) {
    for (const point of group.points) {
      const metrics = byDate.get(point.date) ?? {};
      metrics[group.key] = point.value;
      byDate.set(point.date, metrics);
    }
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, metrics]) => ({ date, metrics }));
}

export function readDataList(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.filter(isRecord);
}

export function nextCursor(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.paging) || !isRecord(body.paging.cursors)) return null;
  return readString(body.paging.cursors, "after");
}

function readInsightTotal(entry: Record<string, unknown>): number | null {
  if (isRecord(entry.total_value)) {
    const total = asNumber(entry.total_value.value);
    if (total !== null) return total;
  }
  if (isRecord(entry.value)) {
    const nested = asNumber(entry.value.value);
    if (nested !== null) return nested;
  }
  const direct = asNumber(entry.value);
  if (direct !== null && !isRecord(entry.value)) return direct;
  if (!Array.isArray(entry.values)) return null;
  const lifetime = entry.values.filter(
    (point): point is Record<string, unknown> => isRecord(point) && typeof point.end_time !== "string",
  );
  if (lifetime.length !== 1) return null;
  return asNumber(lifetime[0]?.value);
}

function readPoints(entry: Record<string, unknown>): Array<{ date: string; value: number }> {
  if (!Array.isArray(entry.values)) return [];
  const points: Array<{ date: string; value: number }> = [];
  for (const point of entry.values) {
    if (!isRecord(point) || typeof point.end_time !== "string") continue;
    const value = asNumber(point.value);
    if (value === null) continue;
    points.push({ date: metaInsightDate(point.end_time), value });
  }
  return points;
}

function readBreakdowns(entry: Record<string, unknown>): Array<{ dimension: string; value: number }> {
  if (!isRecord(entry.total_value) || !Array.isArray(entry.total_value.breakdowns)) return [];
  const breakdowns: Array<{ dimension: string; value: number }> = [];
  for (const breakdown of entry.total_value.breakdowns) {
    if (!isRecord(breakdown) || !Array.isArray(breakdown.results)) continue;
    for (const result of breakdown.results) {
      if (!isRecord(result) || !Array.isArray(result.dimension_values)) continue;
      const dimension = result.dimension_values[0];
      const value = asNumber(result.value);
      if (typeof dimension !== "string" || value === null) continue;
      breakdowns.push({ dimension: dimension.toUpperCase(), value });
    }
  }
  return breakdowns;
}

export function metaInsightDate(endTime: string): string {
  const date = new Date(endTime);
  if (Number.isNaN(date.getTime())) return endTime.slice(0, 10);
  // Page and Instagram day insights use an exclusive end_time at Pacific midnight.
  // 07:00 UTC during PDT, 08:00 UTC during PST. The measured day is the previous Pacific date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date.getTime() - 1000));
}
