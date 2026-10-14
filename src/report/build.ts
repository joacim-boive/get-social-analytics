import { PlatformApiError } from "../platforms/errors.js";
import type {
  AccountProfile,
  AnalyticsReport,
  ContentItem,
  Metric,
  PlatformId,
  PlatformReport,
  ResolvedPeriod,
  SeriesPoint,
  UnavailableMetric,
} from "./types.js";
import { platformLabel } from "./types.js";

export function metric(value: Metric): Metric {
  return value;
}

export function periodBlock(
  period: ResolvedPeriod,
): NonNullable<PlatformReport["period"]> {
  return {
    requested: period.requested,
    applied: { start: period.start, end: period.end },
    notes: period.notes,
  };
}

export function okReport(args: {
  platform: PlatformId;
  account: AccountProfile;
  period: ResolvedPeriod;
  summary?: Metric[];
  series?: SeriesPoint[];
  content?: ContentItem[];
  unavailable?: UnavailableMetric[];
}): PlatformReport {
  const report: PlatformReport = {
    platform: args.platform,
    status: "ok",
    account: args.account,
    period: periodBlock(args.period),
    unavailable: args.unavailable ?? [],
  };
  if (args.summary) report.summary = args.summary;
  if (args.series && args.series.length > 0) report.series = args.series;
  if (args.content) report.content = args.content;
  return report;
}

export function notConfiguredReport(
  platform: PlatformId,
  period: ResolvedPeriod,
): PlatformReport {
  return {
    platform,
    status: "not_configured",
    period: periodBlock(period),
    error: {
      code: "not_configured",
      message: `${platformLabel(platform)} is not connected.`,
      action:
        platform === "youtube"
          ? "Sign in with YouTube on the settings page."
          : "Open the settings page and add credentials for this platform.",
    },
  };
}

export function failureReport(
  platform: PlatformId,
  period: ResolvedPeriod,
  error: unknown,
): PlatformReport {
  const mapped =
    error instanceof PlatformApiError
      ? error
      : new PlatformApiError(
          "api_error",
          error instanceof Error ? error.message : "Unknown error",
          "Try the call again. If it keeps failing, test the connection on the settings page.",
        );
  return {
    platform,
    status: mapped.code === "not_configured" ? "not_configured" : "error",
    period: periodBlock(period),
    error: {
      code: mapped.code,
      message: mapped.message,
      action: mapped.action,
    },
  };
}

export function emptyReport(platforms: PlatformReport[]): AnalyticsReport {
  return { generatedAt: new Date().toISOString(), platforms };
}

export function rankContent(items: ContentItem[]): ContentItem[] {
  return [...items].sort((left, right) => {
    const views = metricRank(right, "views") - metricRank(left, "views");
    if (views !== 0) return views;
    return metricRank(right, "engagements") - metricRank(left, "engagements");
  });
}

function metricRank(item: ContentItem, key: string): number {
  const value = item.metrics.find((entry) => entry.key === key)?.value;
  return typeof value === "number" ? value : Number.NEGATIVE_INFINITY;
}

export function sumMetric(metrics: ParsedNumber[]): number | null {
  const present = metrics.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

type ParsedNumber = number | null | undefined;

export function withNotes(
  period: ResolvedPeriod,
  notes: string[],
): ResolvedPeriod {
  return { ...period, notes: [...period.notes, ...notes] };
}
