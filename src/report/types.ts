export const PLATFORM_IDS = ["instagram", "facebook", "tiktok", "youtube"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export const PERIOD_PRESETS = [
  "yesterday",
  "last_7_days",
  "last_28_days",
  "last_90_days",
  "this_month",
  "last_month",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export type PeriodRequest = { preset: PeriodPreset } | { start: string; end: string };

export type ResolvedPeriod = {
  requested: PeriodRequest;
  start: string;
  end: string;
  notes: string[];
};

export type Aggregation = "period_total" | "snapshot" | "content_lifetime_sum";

export type Metric = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  aggregation: Aggregation;
  source: string;
};

export type SeriesPoint = {
  date: string;
  metrics: Record<string, number | null>;
};

export type ContentItem = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  metricWindow: "period" | "lifetime";
  metrics: Metric[];
};

export type UnavailableMetric = {
  key: string;
  reason: string;
};

export type PlatformErrorBody = {
  code: string;
  message: string;
  action: string;
};

export type AccountProfile = {
  id: string;
  name: string;
  handle: string | null;
};

export type PlatformReport = {
  platform: PlatformId;
  status: "ok" | "error" | "not_configured";
  account?: AccountProfile;
  period?: {
    requested: PeriodRequest;
    applied: { start: string; end: string };
    notes: string[];
  };
  summary?: Metric[];
  series?: SeriesPoint[];
  content?: ContentItem[];
  unavailable?: UnavailableMetric[];
  error?: PlatformErrorBody;
};

export type AnalyticsReport = {
  generatedAt: string;
  platforms: PlatformReport[];
};

export type ReportFormat = "json" | "markdown";

export type IncludeMode = "summary" | "content" | "both";

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

export function platformLabel(platform: PlatformId): string {
  if (platform === "instagram") return "Instagram";
  if (platform === "facebook") return "Facebook";
  if (platform === "tiktok") return "TikTok";
  return "YouTube";
}
