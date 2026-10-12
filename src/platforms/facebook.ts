import { metric, okReport, rankContent, withNotes } from "../report/build.js";
import {
  clampLookback,
  daysBefore,
  formatIsoDate,
  isWithinPeriod,
  periodUnixRange,
} from "../report/period.js";
import type {
  AccountProfile,
  ContentItem,
  Metric,
  PlatformReport,
  UnavailableMetric,
} from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { asNumber, clipText, isRecord, readString } from "../util.js";
import type { AnalyticsQuery, PlatformClient } from "./client.js";
import { PlatformApiError } from "./errors.js";
import {
  FACEBOOK_GRAPH,
  fetchInsightMetrics,
  graphGet,
  insightByName,
  nextCursor,
  readDataList,
  seriesFromPoints,
  summedPoints,
} from "./insights.js";
import { rememberAccount, requireConnection } from "./remember.js";

const DAILY_METRICS = [
  ["page_media_view", "views"],
  ["page_post_engagements", "engagements"],
  ["page_daily_follows_unique", "followers_gained"],
  ["page_daily_unfollows_unique", "followers_lost"],
] as const;

export const facebookClient: PlatformClient = {
  id: "facebook",
  capabilities: [
    "Page views, post engagements, and follow changes over a selected range.",
    "Current Page follower count.",
    "Lifetime reaction, comment, and share counts for posts published in the range.",
  ],
  limitations: [
    "No watch time.",
    "Reach is included only when Facebook returns a range unique, because daily unique counts cannot be added together.",
    "Post counts are lifetime totals, not activity during the range.",
    "Deprecated metrics such as page_fans and page_impressions are not requested.",
  ],
  test: testFacebook,
  analytics: (store, query) => loadFacebook(store, query, "analytics"),
  content: (store, query) => loadFacebook(store, query, "content"),
};

async function testFacebook(store: CredentialStore): Promise<AccountProfile> {
  const connection = requireConnection(store, "facebook");
  const page = await fetchPage(
    connection.credentials.pageAccessToken,
    connection.credentials.pageId,
  );
  store.save(
    "facebook",
    { ...connection.credentials, pageId: page.pageId },
    { account: page.account },
  );
  return page.account;
}

async function loadFacebook(
  store: CredentialStore,
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<PlatformReport> {
  const connection = requireConnection(store, "facebook");
  const token = connection.credentials.pageAccessToken;
  const today = formatIsoDate(new Date());
  const period = clampLookback(
    query.period,
    daysBefore(today, 730),
    "Facebook Page insights were limited to about two years. The start date was moved forward.",
  );
  const page = await fetchPage(token, connection.credentials.pageId);
  store.save(
    "facebook",
    { pageAccessToken: token, pageId: page.pageId },
    { account: page.account },
  );
  const wantSummary = mode === "analytics" && query.include !== "content";
  const wantContent = mode === "content" || query.include !== "summary";
  const unavailable: UnavailableMetric[] = [
    {
      key: "watch_time_minutes",
      reason: "Facebook Page insights do not provide watch time.",
    },
  ];
  const notes = [
    "Facebook post metrics are lifetime totals for posts published in the range, not activity during the range.",
  ];
  let summary: Metric[] | undefined;
  let series: ReturnType<typeof seriesFromPoints> | undefined;
  if (wantSummary) {
    const built = await loadSummary(token, page, period, unavailable);
    summary = built.summary;
    series = built.series;
  }
  const content = wantContent
    ? await loadContent(
        token,
        page.pageId,
        period,
        query.contentLimit,
        unavailable,
      )
    : undefined;
  return okReport({
    platform: "facebook",
    account: page.account,
    period: withNotes(period, notes),
    summary,
    series,
    content,
    unavailable,
  });
}

async function loadSummary(
  token: string,
  page: { account: AccountProfile; followers: number | null; pageId: string },
  period: AnalyticsQuery["period"],
  unavailable: UnavailableMetric[],
): Promise<{ summary: Metric[]; series: ReturnType<typeof seriesFromPoints> }> {
  const range = periodUnixRange(period);
  const summary: Metric[] = [];
  if (page.followers !== null) {
    summary.push(
      metric({
        key: "followers",
        label: "Followers",
        value: page.followers,
        unit: "accounts",
        aggregation: "snapshot",
        source: "followers_count",
      }),
    );
  } else {
    unavailable.push({
      key: "followers",
      reason: "Facebook did not return a follower count for this Page.",
    });
  }

  const seriesGroups: Array<{
    key: string;
    points: Array<{ date: string; value: number }>;
  }> = [];
  for (const [source, key] of DAILY_METRICS) {
    const result = await fetchInsightMetrics({
      host: FACEBOOK_GRAPH,
      path: `${page.pageId}/insights`,
      token,
      metrics: [source],
      params: {
        period: "day",
        since: String(range.since),
        until: String(range.until),
      },
      keyForMetric: () => key,
    });
    unavailable.push(...result.unavailable);
    const insight = insightByName(result.parsed, source);
    const total = summedPoints(insight);
    if (total === null) {
      if (!unavailable.some((item) => item.key === key)) {
        unavailable.push({
          key,
          reason: `Facebook did not return ${source} for this range.`,
        });
      }
      continue;
    }
    const unit =
      key === "views"
        ? "views"
        : key === "engagements"
          ? "interactions"
          : "accounts";
    summary.push(
      metric({
        key,
        label: labelFor(key),
        value: total,
        unit,
        aggregation: "period_total",
        source,
      }),
    );
    seriesGroups.push({ key, points: insight?.points ?? [] });
  }

  const reach = await fetchInsightMetrics({
    host: FACEBOOK_GRAPH,
    path: `${page.pageId}/insights`,
    token,
    metrics: ["page_total_media_view_unique"],
    params: {
      period: "total_over_range",
      since: String(range.since),
      until: String(range.until),
    },
    keyForMetric: () => "reach",
  });
  const reachMetric = insightByName(
    reach.parsed,
    "page_total_media_view_unique",
  );
  const reachTotal =
    reachMetric?.totalValue ??
    (reachMetric && reachMetric.points.length === 1
      ? (reachMetric.points[0]?.value ?? null)
      : null);
  if (reachTotal === null) {
    unavailable.push({
      key: "reach",
      reason:
        reach.unavailable[0]?.reason ??
        "Facebook did not return a range unique for media views. Daily unique counts were not added together.",
    });
  } else {
    summary.push(
      metric({
        key: "reach",
        label: "Accounts reached",
        value: reachTotal,
        unit: "accounts",
        aggregation: "period_total",
        source: "page_total_media_view_unique",
      }),
    );
  }

  return { summary, series: seriesFromPoints(seriesGroups) };
}

async function loadContent(
  token: string,
  pageId: string,
  period: AnalyticsQuery["period"],
  contentLimit: number,
  unavailable: UnavailableMetric[],
): Promise<ContentItem[]> {
  const posts = await listPosts(token, pageId, period);
  const ranked = rankContent(
    posts.map((post) => toContentItem(post, null)),
  ).slice(0, contentLimit);
  let viewMisses = 0;
  const withViews: ContentItem[] = [];
  for (const item of ranked) {
    const views = await postViews(token, item.id);
    if (views === null) viewMisses += 1;
    const metrics = [...item.metrics];
    if (views !== null) {
      metrics.unshift(
        metric({
          key: "views",
          label: "Views",
          value: views,
          unit: "views",
          aggregation: "content_lifetime_sum",
          source: "post_media_view",
        }),
      );
    }
    withViews.push({ ...item, metrics });
  }
  if (viewMisses > 0) {
    unavailable.push({
      key: "views",
      reason:
        "Facebook did not return post_media_view for every post. Those posts are ranked on reactions, comments, and shares.",
    });
  }
  return rankContent(withViews);
}

async function listPosts(
  token: string,
  pageId: string,
  period: AnalyticsQuery["period"],
): Promise<Record<string, unknown>[]> {
  const fields =
    "id,message,created_time,permalink_url,status_type,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)";
  try {
    return await pagePosts(token, pageId, "published_posts", fields, period);
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
    return pagePosts(token, pageId, "posts", fields, period);
  }
}

async function pagePosts(
  token: string,
  pageId: string,
  edge: string,
  fields: string,
  period: AnalyticsQuery["period"],
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < 6; page += 1) {
    const params: Record<string, string> = { fields, limit: "25" };
    if (after) params.after = after;
    const body = await graphGet(
      FACEBOOK_GRAPH,
      `${pageId}/${edge}`,
      token,
      params,
    );
    let reachedOlder = false;
    for (const record of readDataList(body)) {
      const created = readString(record, "created_time");
      if (created && formatIsoDate(new Date(created)) < period.start) {
        reachedOlder = true;
        break;
      }
      if (!created || isWithinPeriod(created, period)) collected.push(record);
    }
    if (reachedOlder) break;
    after = nextCursor(body);
    if (!after) break;
  }
  return collected.slice(0, 40);
}

function toContentItem(
  record: Record<string, unknown>,
  views: number | null,
): ContentItem {
  const reactions = summaryCount(record, "reactions");
  const comments = summaryCount(record, "comments");
  const shares = isRecord(record.shares) ? asNumber(record.shares.count) : null;
  const metrics: Metric[] = [];
  if (views !== null) {
    metrics.push(
      metric({
        key: "views",
        label: "Views",
        value: views,
        unit: "views",
        aggregation: "content_lifetime_sum",
        source: "post_media_view",
      }),
    );
  }
  pushCount(metrics, "reactions", "Reactions", reactions, "reactions.summary");
  pushCount(metrics, "comments", "Comments", comments, "comments.summary");
  pushCount(metrics, "shares", "Shares", shares, "shares.count");
  const parts = [reactions, comments, shares].filter(
    (value): value is number => value !== null,
  );
  if (parts.length > 0) {
    metrics.push(
      metric({
        key: "engagements",
        label: "Engagements",
        value: parts.reduce((total, value) => total + value, 0),
        unit: "interactions",
        aggregation: "content_lifetime_sum",
        source: "reactions+comments+shares",
      }),
    );
  }
  const message = readString(record, "message");
  return {
    id: readString(record, "id") ?? "unknown",
    kind: (readString(record, "status_type") ?? "post").toLowerCase(),
    title: message ? clipText(message) : "(no message)",
    url: readString(record, "permalink_url"),
    publishedAt: readString(record, "created_time"),
    metricWindow: "lifetime",
    metrics,
  };
}

async function postViews(
  token: string,
  postId: string,
): Promise<number | null> {
  try {
    const result = await fetchInsightMetrics({
      host: FACEBOOK_GRAPH,
      path: `${postId}/insights`,
      token,
      metrics: ["post_media_view"],
      params: {},
      keyForMetric: () => "views",
    });
    const insight = insightByName(result.parsed, "post_media_view");
    return insight?.totalValue ?? summedPoints(insight);
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
    return null;
  }
}

async function fetchPage(
  token: string,
  pageId: string | null,
): Promise<{
  account: AccountProfile;
  followers: number | null;
  pageId: string;
}> {
  const body = await graphGet(FACEBOOK_GRAPH, pageId ?? "me", token, {
    fields: "id,name,username,followers_count",
  });
  if (!isRecord(body)) {
    throw new PlatformApiError(
      "api_error",
      "Facebook returned an unreadable Page.",
      "Paste a Page access token and try again.",
    );
  }
  const id = readString(body, "id");
  if (!id)
    throw new PlatformApiError(
      "api_error",
      "Facebook did not return a Page id.",
      "Paste the Page id on the settings page.",
    );
  const username = readString(body, "username");
  return {
    pageId: id,
    followers: asNumber(body.followers_count),
    account: {
      id,
      name: readString(body, "name") ?? username ?? id,
      handle: username,
    },
  };
}

function summaryCount(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (!isRecord(value) || !isRecord(value.summary)) return null;
  return asNumber(value.summary.total_count);
}

function pushCount(
  metrics: Metric[],
  key: string,
  label: string,
  value: number | null,
  source: string,
): void {
  if (value === null) return;
  metrics.push(
    metric({
      key,
      label,
      value,
      unit: "count",
      aggregation: "content_lifetime_sum",
      source,
    }),
  );
}

function labelFor(key: string): string {
  if (key === "views") return "Views";
  if (key === "engagements") return "Engagements";
  if (key === "followers_gained") return "Followers gained";
  return "Followers lost";
}
