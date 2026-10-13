import { inclusiveDays, localDateFromIso } from "./period.js";
import type {
  Aggregation,
  AnalyticsReport,
  ChannelCheck,
  ContentItem,
  Metric,
  PlatformId,
  PlatformReport,
  ResolvedPeriod,
  UnavailableMetric,
} from "./types.js";

export type MetricScope = "period" | "lifetime" | "snapshot" | "derived";

export type MetricReading = {
  value: number | null;
  sourceMetric: string | null;
  scope: MetricScope;
  definition: string;
};

export type ComparisonPeriod = {
  key: string;
  startDate: string;
  endDate: string;
  startInclusive: true;
  endInclusive: true;
  days: number;
};

export type ComparisonAccount = {
  handle: string | null;
  accountId: string | null;
  title: string | null;
  channelId: string | null;
  subscriberCount: number | null;
};

export type DailyRow = {
  date: string;
  views: MetricReading | null;
  reach: MetricReading | null;
  engagements: MetricReading | null;
  followersGained: MetricReading | null;
  followersLost: MetricReading | null;
  audienceTotal: MetricReading | null;
};

export type ContentMetrics = {
  views: MetricReading | null;
  reach: MetricReading | null;
  impressions: MetricReading | null;
  watchTimeMinutes: MetricReading | null;
  averageViewDurationSeconds: MetricReading | null;
  averageViewPercentage: MetricReading | null;
  completionRate: MetricReading | null;
  likes: MetricReading | null;
  comments: MetricReading | null;
  shares: MetricReading | null;
  saves: MetricReading | null;
  videoDurationSeconds: MetricReading | null;
  followsAttributed: MetricReading | null;
  reactions: MetricReading | null;
};

export type ComparisonContent = {
  id: string;
  type: string;
  titleOrCaption: string;
  publishedAt: string | null;
  permalink: string | null;
  publishedWithinPeriod: boolean | null;
  ageAtPeriodEndDays: number | null;
  rankMetric: string;
  rankValue: number | null;
  metrics: ContentMetrics;
  retention: null;
};

export type ContentRanking = {
  metric: string;
  scope: "period" | "lifetime" | "snapshot";
  method: string;
};

export type ComparisonSummary = {
  followersSnapshot: MetricReading;
  subscribersSnapshot: MetricReading;
  views: MetricReading;
  reach: MetricReading;
  impressions: MetricReading;
  engagements: MetricReading;
  likes: MetricReading;
  comments: MetricReading;
  shares: MetricReading;
  saves: MetricReading;
  followersGained: MetricReading;
  followersLost: MetricReading;
  netFollowerChange: MetricReading;
  watchTimeMinutes: MetricReading;
  averageViewDurationSeconds: MetricReading;
  averageViewPercentage: MetricReading;
  completionRate: MetricReading;
};

export type ComparisonPlatform = {
  status: "ok" | "partial" | "unavailable" | "error";
  account: ComparisonAccount;
  dataThrough: string | null;
  appliedPeriod: ComparisonPeriod | null;
  notes: string[];
  timezone: string;
  summary: ComparisonSummary;
  daily: DailyRow[];
  content: ComparisonContent[];
  contentRanking: ContentRanking;
  unavailableMetrics: UnavailableMetric[];
  error: { code: string; message: string; action: string } | null;
  channelCheck: ChannelCheck | null;
};

export type ComparisonReport = {
  generatedAt: string;
  timezone: string;
  period: ComparisonPeriod;
  platforms: Record<string, ComparisonPlatform>;
};

const NOT_REPORTED = "The connected platform call did not return this metric.";

export function toComparison(
  report: AnalyticsReport,
  requested: ResolvedPeriod,
): ComparisonReport {
  const period = describePeriod(requested);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const platforms: Record<string, ComparisonPlatform> = {};
  for (const block of report.platforms)
    platforms[block.platform] = toPlatform(block, period, timezone);
  return {
    generatedAt: report.generatedAt,
    timezone,
    period,
    platforms,
  };
}

function describePeriod(period: ResolvedPeriod): ComparisonPeriod {
  return {
    key: "preset" in period.requested ? period.requested.preset : "custom",
    startDate: period.start,
    endDate: period.end,
    startInclusive: true,
    endInclusive: true,
    days: inclusiveDays(period.start, period.end),
  };
}

function toPlatform(
  block: PlatformReport,
  requested: ComparisonPeriod,
  requestTimezone: string,
): ComparisonPlatform {
  const unavailable = [...(block.unavailable ?? [])];
  const blankTable = unavailable.some((item) => item.key === "series");
  const summary = buildSummary(block, blankTable);
  const daily = buildDaily(block).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const dataThrough = latestReportedDate(daily);
  const content = (block.content ?? []).map((item) =>
    toContent(item, requested),
  );
  const ranked = rankComparison(content, block.platform);
  addStandingGaps(block.platform, summary, unavailable);
  explainMissingSummary(summary, unavailable);
  if (summary.netFollowerChange.value === null) {
    addGap(
      unavailable,
      "netFollowerChange",
      summary.netFollowerChange.definition,
    );
  }
  const notes = [...(block.period?.notes ?? [])];
  const dailyViews = daily.reduce(
    (total, row) =>
      row.views?.value == null ? total : total + row.views.value,
    0,
  );
  const countedDays = daily.filter((row) => row.views?.value != null).length;
  if (
    block.platform === "facebook" &&
    countedDays > 0 &&
    summary.views.value !== null &&
    summary.views.value !== dailyViews
  ) {
    notes.push(
      `Daily page_media_view values sum to ${dailyViews} across ${countedDays} Pacific days. The summary is ${summary.views.value}. Both come from the returned buckets; each date is the Pacific day that ends at the exclusive end_time.`,
    );
  }
  return {
    status: comparisonStatus(
      block,
      requested,
      dataThrough,
      unavailable,
      summary,
      daily,
      ranked.items,
    ),
    account: toAccount(block, summary),
    dataThrough,
    appliedPeriod: appliedPeriod(block, requested),
    notes,
    timezone: platformTimezone(block.platform, requestTimezone),
    summary,
    daily,
    content: ranked.items,
    contentRanking: ranked.ranking,
    unavailableMetrics: unavailable.map(classifyGap),
    error: block.error ?? null,
    channelCheck: block.channelCheck ?? null,
  };
}

function toAccount(
  block: PlatformReport,
  summary: ComparisonSummary,
): ComparisonAccount {
  return {
    handle: block.account?.handle ?? null,
    accountId: block.account?.id ?? null,
    title: block.account?.name ?? null,
    channelId:
      block.platform === "youtube" ? (block.account?.id ?? null) : null,
    subscriberCount:
      block.platform === "youtube" ? summary.subscribersSnapshot.value : null,
  };
}

function appliedPeriod(
  block: PlatformReport,
  requested: ComparisonPeriod,
): ComparisonPeriod {
  const applied = block.period?.applied;
  const startDate = applied?.start ?? requested.startDate;
  const endDate = applied?.end ?? requested.endDate;
  return {
    key: "applied",
    startDate,
    endDate,
    startInclusive: true,
    endInclusive: true,
    days: inclusiveDays(startDate, endDate),
  };
}

function buildSummary(
  block: PlatformReport,
  blankTable: boolean,
): ComparisonSummary {
  const read = (key: string, definition: string): MetricReading => {
    const found = findMetric(block.summary, key);
    if (!found) return missing(definition);
    if (blankTable && found.aggregation === "period_total" && found.value === 0)
      return missing(definition);
    return reading(found, definition);
  };
  const followers = read(
    "followers",
    "Current audience count. This is not a count of follows during the period.",
  );
  const youtube = block.platform === "youtube";
  const followersGained = read(
    "followers_gained",
    "Accounts that followed during the period, as reported by the platform.",
  );
  const followersLost = read(
    "followers_lost",
    "Accounts that unfollowed during the period, as reported by the platform.",
  );
  const summary: ComparisonSummary = {
    followersSnapshot: youtube
      ? missing("YouTube reports subscribers, not followers.", "snapshot")
      : { ...followers, scope: "snapshot" },
    subscribersSnapshot: youtube
      ? {
          ...followers,
          scope: "snapshot",
          definition:
            "Current subscriber count for the authenticated channel. This is not subscribers gained.",
        }
      : missing(
          "This platform reports followers, not subscribers.",
          "snapshot",
        ),
    views: read(
      "views",
      "Views reported for this platform's native window. Read scope before comparing it with another platform.",
    ),
    reach: read(
      "reach",
      "Unique accounts reached during the period, only when the platform returns one range figure.",
    ),
    impressions: missing(
      "Impressions are not requested. Deprecated impression metrics stay unrequested, and views are not relabeled as impressions.",
    ),
    engagements: read(
      "engagements",
      "Interactions reported for this platform's native window.",
    ),
    likes: read("likes", "Likes reported for this platform's native window."),
    comments: read(
      "comments",
      "Comments reported for this platform's native window.",
    ),
    shares: read(
      "shares",
      "Shares reported for this platform's native window.",
    ),
    saves: read("saves", "Saves reported for this platform's native window."),
    followersGained,
    followersLost,
    netFollowerChange: netChange(followersGained, followersLost),
    watchTimeMinutes: read(
      "watch_time_minutes",
      "Watch time in minutes during the period.",
    ),
    averageViewDurationSeconds: read(
      "average_view_duration_seconds",
      "YouTube Analytics averageViewDuration for the period, in seconds. This is not estimated from watch time divided by views.",
    ),
    averageViewPercentage: read(
      "average_view_percentage",
      "YouTube Analytics averageViewPercentage for the period. This is not a completion rate.",
    ),
    completionRate: missing(
      "No connected platform returns a separate completion rate. averageViewPercentage is not relabeled as one.",
    ),
  };
  return summary;
}

function netChange(gained: MetricReading, lost: MetricReading): MetricReading {
  if (
    gained.value === null ||
    lost.value === null ||
    gained.scope !== "period" ||
    lost.scope !== "period"
  ) {
    return {
      value: null,
      sourceMetric: null,
      scope: "derived",
      definition:
        "Not calculated. Both a period follower gain and a period follower loss are required, and a follower snapshot is never used as a substitute.",
    };
  }
  return {
    value: gained.value - lost.value,
    sourceMetric: `${gained.sourceMetric} - ${lost.sourceMetric}`,
    scope: "derived",
    definition:
      "Followers gained minus followers lost, using the platform's reported period counts. This is not a separate platform metric.",
  };
}

function buildDaily(block: PlatformReport): DailyRow[] {
  return (block.series ?? []).flatMap((point) => {
    const row: DailyRow = {
      date: point.date,
      views: dailyReading(block.platform, "views", point.metrics.views),
      reach: dailyReading(block.platform, "reach", point.metrics.reach),
      engagements: dailyReading(
        block.platform,
        "engagements",
        point.metrics.engagements,
      ),
      followersGained: dailyReading(
        block.platform,
        "followers_gained",
        point.metrics.followers_gained,
      ),
      followersLost: dailyReading(
        block.platform,
        "followers_lost",
        point.metrics.followers_lost,
      ),
      audienceTotal:
        block.platform === "instagram"
          ? dailyReading(block.platform, "followers", point.metrics.followers)
          : null,
    };
    const present = [
      row.views,
      row.reach,
      row.engagements,
      row.followersGained,
      row.followersLost,
      row.audienceTotal,
    ];
    return present.some((item) => item !== null) ? [row] : [];
  });
}

function dailyReading(
  platform: PlatformId,
  key: string,
  value: number | null | undefined,
): MetricReading | null {
  if (value === undefined || value === null) return null;
  const described = dailySource(platform, key);
  if (!described) return null;
  return {
    value,
    sourceMetric: described.source,
    scope: described.scope,
    definition: described.definition,
  };
}

function dailySource(
  platform: PlatformId,
  key: string,
): { source: string; scope: MetricScope; definition: string } | null {
  if (platform === "instagram" && key === "followers") {
    return {
      source: "follower_count",
      scope: "snapshot",
      definition:
        "Follower total at the end of the day. This is not new followers, and the change from the previous day is not reported as follows.",
    };
  }
  if (platform === "facebook" && key === "views") {
    return {
      source: "page_media_view",
      scope: "period",
      definition: "Facebook page_media_view for that day.",
    };
  }
  if (platform === "facebook" && key === "engagements") {
    return {
      source: "page_post_engagements",
      scope: "period",
      definition: "Facebook page_post_engagements for that day.",
    };
  }
  if (platform === "facebook" && key === "followers_gained") {
    return {
      source: "page_daily_follows_unique",
      scope: "period",
      definition: "Unique accounts that followed the Page that day.",
    };
  }
  if (platform === "facebook" && key === "followers_lost") {
    return {
      source: "page_daily_unfollows_unique",
      scope: "period",
      definition: "Unique accounts that unfollowed the Page that day.",
    };
  }
  if (platform === "youtube" && key === "views") {
    return {
      source: "views",
      scope: "period",
      definition: "YouTube Analytics views for that day.",
    };
  }
  if (platform === "youtube" && key === "engagements") {
    return {
      source: "likes+comments+shares",
      scope: "period",
      definition:
        "Sum of YouTube Analytics likes, comments, and shares for that day.",
    };
  }
  if (platform === "youtube" && key === "followers_gained") {
    return {
      source: "subscribersGained",
      scope: "period",
      definition: "YouTube Analytics subscribersGained for that day.",
    };
  }
  if (platform === "youtube" && key === "followers_lost") {
    return {
      source: "subscribersLost",
      scope: "period",
      definition: "YouTube Analytics subscribersLost for that day.",
    };
  }
  return null;
}

function latestReportedDate(rows: DailyRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    const reported = [
      row.views,
      row.reach,
      row.engagements,
      row.followersGained,
      row.followersLost,
    ].some((item) => item !== null);
    if (!reported) continue;
    if (!latest || row.date > latest) latest = row.date;
  }
  return latest;
}

function toContent(
  item: ContentItem,
  period: ComparisonPeriod,
): ComparisonContent {
  const publishedDay = item.publishedAt
    ? localDateFromIso(item.publishedAt)
    : null;
  const read = (key: string, definition: string): MetricReading | null => {
    const found = findMetric(item.metrics, key);
    return found ? reading(found, definition) : null;
  };
  return {
    id: item.id,
    type: item.kind,
    titleOrCaption: item.title,
    publishedAt: item.publishedAt,
    permalink: item.url,
    publishedWithinPeriod: publishedDay
      ? publishedDay >= period.startDate && publishedDay <= period.endDate
      : null,
    ageAtPeriodEndDays: publishedDay
      ? inclusiveDays(publishedDay, period.endDate) - 1
      : null,
    rankMetric: "views",
    rankValue: null,
    metrics: {
      views: read(
        "views",
        item.metricWindow === "period"
          ? "Views during the requested period."
          : "Lifetime views. Not views during the requested period.",
      ),
      reach: read(
        "reach",
        "Lifetime accounts reached, when the media insight returns reach.",
      ),
      impressions: null,
      watchTimeMinutes: read(
        "watch_time_minutes",
        "Watch time in minutes. Read scope and sourceMetric. Instagram reel and Facebook video values are lifetime totals converted from milliseconds.",
      ),
      averageViewDurationSeconds: read(
        "average_view_duration_seconds",
        "Average view duration in seconds. YouTube values are period averages. Instagram reel and Facebook video values are lifetime averages converted from milliseconds.",
      ),
      averageViewPercentage: read(
        "average_view_percentage",
        "YouTube Analytics averageViewPercentage for this video during the period.",
      ),
      completionRate: null,
      likes: read(
        "likes",
        item.metricWindow === "period"
          ? "Likes during the requested period."
          : "Lifetime likes. Not likes during the requested period.",
      ),
      comments: read(
        "comments",
        item.metricWindow === "period"
          ? "Comments during the requested period."
          : "Lifetime comments. Not comments during the requested period.",
      ),
      shares: read(
        "shares",
        item.metricWindow === "period"
          ? "Shares during the requested period."
          : "Lifetime shares. Not shares during the requested period.",
      ),
      saves: read(
        "saves",
        "Lifetime saves. Not saves during the requested period.",
      ),
      videoDurationSeconds: read(
        "video_duration_seconds",
        "Length of the video in seconds. This is not watch time.",
      ),
      followsAttributed: null,
      reactions: read(
        "reactions",
        "Lifetime Facebook reactions. These are not likes.",
      ),
    },
    retention: null,
  };
}

function rankComparison(
  items: ComparisonContent[],
  platform: PlatformId,
): { items: ComparisonContent[]; ranking: ContentRanking } {
  const periodViews = platform === "youtube";
  const interaction = (item: ComparisonContent): number | null => {
    const parts = [
      item.metrics.likes,
      item.metrics.comments,
      item.metrics.shares,
      item.metrics.saves,
      item.metrics.reactions,
    ]
      .map((entry) => entry?.value)
      .filter((value): value is number => typeof value === "number");
    if (parts.length > 0)
      return parts.reduce((total, value) => total + value, 0);
    return null;
  };
  const hasViews = items.some(
    (item) => typeof item.metrics.views?.value === "number",
  );
  const hasInteraction = items.some((item) => interaction(item) !== null);
  const metric = hasViews
    ? "views"
    : hasInteraction
      ? "engagements"
      : "publishedAt";
  const valueOf = (item: ComparisonContent): number | null => {
    if (metric === "views") return item.metrics.views?.value ?? null;
    if (metric === "engagements") return interaction(item);
    if (!item.publishedAt) return null;
    const time = new Date(item.publishedAt).getTime();
    return Number.isNaN(time) ? null : time;
  };
  const sorted = [...items]
    .sort((left, right) => {
      const leftValue = valueOf(left);
      const rightValue = valueOf(right);
      if (leftValue === null && rightValue === null) return 0;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue;
    })
    .map((item) => ({ ...item, rankMetric: metric, rankValue: valueOf(item) }));
  const method =
    metric === "views"
      ? periodViews
        ? "Ranked by views during the requested period. rankValue is that view count."
        : "Ranked by lifetime views. rankValue is that view count, not views during the period."
      : metric === "engagements"
        ? "Views were missing, so items are ranked by the sum of available likes, comments, shares, saves, and reactions. rankValue is that sum."
        : "Views and interaction counts were missing, so items are ranked by publication time. rankValue is the publishedAt timestamp in milliseconds.";
  return {
    items: sorted,
    ranking: {
      metric,
      scope:
        metric === "views" && periodViews
          ? "period"
          : metric === "publishedAt"
            ? "snapshot"
            : "lifetime",
      method,
    },
  };
}

function platformTimezone(
  platform: PlatformId,
  requestTimezone: string,
): string {
  if (platform === "facebook" || platform === "youtube")
    return "America/Los_Angeles";
  return requestTimezone;
}

function comparisonStatus(
  block: PlatformReport,
  requested: ComparisonPeriod,
  dataThrough: string | null,
  unavailable: UnavailableMetric[],
  summary: ComparisonSummary,
  daily: DailyRow[],
  content: ComparisonContent[],
): ComparisonPlatform["status"] {
  if (block.status === "error") return "error";
  if (block.status === "not_configured") return "unavailable";
  if (block.channelCheck && !block.channelCheck.match) return "partial";
  const hasValue =
    Object.values(summary).some((item) => item.value !== null) ||
    daily.length > 0 ||
    content.length > 0;
  if (!hasValue) return "unavailable";
  const clamped =
    block.period?.applied !== undefined &&
    (block.period.applied.start !== requested.startDate ||
      block.period.applied.end !== requested.endDate);
  const lag = dataThrough !== null && dataThrough < requested.endDate;
  const gaps = unavailable.filter((item) => !standingGap(item.reason));
  if (clamped || lag || gaps.length > 0) return "partial";
  return "ok";
}

function standingGap(reason: string): boolean {
  const text = reason.toLowerCase();
  return (
    text.includes("does not provide") ||
    text.includes("do not include") ||
    text.includes("does not return a video duration") ||
    text.includes("not requested") ||
    text.includes("are not requested") ||
    text.includes("not relabeled") ||
    text.includes("not a separate") ||
    text.includes("hides its subscriber") ||
    text.includes("reports subscribers") ||
    text.includes("reports followers") ||
    text.includes("not calculated")
  );
}

function addStandingGaps(
  platform: PlatformId,
  summary: ComparisonSummary,
  unavailable: UnavailableMetric[],
): void {
  if (summary.impressions.value === null)
    addGap(unavailable, "impressions", summary.impressions.definition);
  if (summary.completionRate.value === null)
    addGap(unavailable, "completionRate", summary.completionRate.definition);
  addGap(
    unavailable,
    "followsAttributed",
    "Follows attributed to an individual post are not requested.",
  );
  addGap(
    unavailable,
    "retention",
    "Audience retention curves are not requested.",
  );
  if (
    platform !== "youtube" &&
    summary.watchTimeMinutes.value === null &&
    !unavailable.some((item) => item.key === "watch_time_minutes")
  ) {
    addGap(
      unavailable,
      "watchTimeMinutes",
      summary.watchTimeMinutes.definition,
    );
  }
}

function classifyGap(item: UnavailableMetric): UnavailableMetric {
  if (item.code) return item;
  const text = item.reason.toLowerCase();
  let code: UnavailableMetric["code"] = "no_data";
  if (text.includes("not requested") || text.includes("are not requested"))
    code = "not_requested";
  else if (text.includes("permission") || text.includes("denied"))
    code = "permission_denied";
  else if (
    text.includes("does not") ||
    text.includes("do not include") ||
    text.includes("unsupported") ||
    text.includes("not available")
  )
    code = "unsupported";
  else if (text.includes("rejected") || text.includes("api error"))
    code = "api_error";
  return { ...item, code };
}

function addGap(
  unavailable: UnavailableMetric[],
  key: string,
  reason: string,
): void {
  if (unavailable.some((item) => item.key === key)) return;
  unavailable.push({ key, reason });
}

function findMetric(
  metrics: Metric[] | undefined,
  key: string,
): Metric | undefined {
  return metrics?.find((item) => item.key === key);
}

function reading(metric: Metric, definition: string): MetricReading {
  return {
    value: metric.value,
    sourceMetric: metric.source,
    scope: scopeFor(metric.aggregation),
    definition,
  };
}

function explainMissingSummary(
  summary: ComparisonSummary,
  unavailable: UnavailableMetric[],
): void {
  const reasons: Array<[keyof ComparisonSummary, string]> = [
    [
      "likes",
      "Account-level likes are not requested. Likes on individual posts stay on content and keep their own scope.",
    ],
    [
      "comments",
      "Account-level comments are not requested. Comments on individual posts stay on content and keep their own scope.",
    ],
    [
      "shares",
      "Account-level shares are not requested. Shares on individual posts stay on content and keep their own scope.",
    ],
    [
      "saves",
      "Account-level saves are not requested. Saves on individual posts stay on content and keep their own scope.",
    ],
    ["reach", "Reach was not returned for this period."],
    ["views", "Views were not returned for this period."],
    ["engagements", "Engagements were not returned for this period."],
  ];
  for (const [key, reason] of reasons) {
    if (summary[key].value === null) addGap(unavailable, key, reason);
  }
}

function missing(
  definition: string,
  scope: MetricScope = "period",
): MetricReading {
  return { value: null, sourceMetric: null, scope, definition };
}

function scopeFor(aggregation: Aggregation): MetricScope {
  if (aggregation === "snapshot") return "snapshot";
  if (aggregation === "content_lifetime_sum") return "lifetime";
  return "period";
}
