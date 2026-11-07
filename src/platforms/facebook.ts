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
import { mapMetaError, PlatformApiError } from "./errors.js";
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
import { requestJson } from "./http.js";
import { rememberAccount, requireConnection } from "./remember.js";

const FACEBOOK_SCOPES = "pages_show_list,pages_read_engagement,read_insights";

export type FacebookPageGrant = { id: string; name: string; accessToken: string };

export type FacebookSignIn =
  | { status: "connected"; pageAccessToken: string; pageId: string; pageName: string }
  | { status: "choose"; pages: FacebookPageGrant[] };

export function facebookAppConfig(stored?: {
  appId: string | null;
  appSecret: string | null;
} | null): { appId: string; appSecret: string } | null {
  const envId = process.env.META_FACEBOOK_APP_ID?.trim() ?? "";
  const envSecret = process.env.META_FACEBOOK_APP_SECRET?.trim() ?? "";
  if (envId && envSecret) return { appId: envId, appSecret: envSecret };
  if (stored?.appId && stored.appSecret) return { appId: stored.appId, appSecret: stored.appSecret };
  return null;
}

export function facebookAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const version = FACEBOOK_GRAPH.split("/").at(-1) ?? "v26.0";
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FACEBOOK_SCOPES);
  url.searchParams.set("state", args.state);
  return url.toString();
}

export async function exchangeFacebookCode(args: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  pageId: string | null;
}): Promise<FacebookSignIn> {
  const shortLived = await facebookUserToken({
    client_id: args.appId,
    client_secret: args.appSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
  });
  const longLived = await facebookUserToken({
    grant_type: "fb_exchange_token",
    client_id: args.appId,
    client_secret: args.appSecret,
    fb_exchange_token: shortLived,
  });
  const pages = await listManagedPages(longLived);
  if (!args.pageId && pages.length > 1) return { status: "choose", pages };
  const page = pickPage(pages, args.pageId);
  return { status: "connected", pageAccessToken: page.accessToken, pageId: page.id, pageName: page.name };
}

async function facebookUserToken(params: Record<string, string>): Promise<string> {
  const url = new URL(`${FACEBOOK_GRAPH}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const { status, body } = await requestJson(url.toString());
  if (isRecord(body) && typeof body.access_token === "string") return body.access_token;
  throw mapMetaError(body, status || 400);
}

async function listManagedPages(token: string): Promise<FacebookPageGrant[]> {
  const body = await graphGet(FACEBOOK_GRAPH, "/me/accounts", token, { fields: "id,name,access_token" });
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.access_token !== "string") return [];
    const name = typeof entry.name === "string" ? entry.name : entry.id;
    return [{ id: entry.id, name, accessToken: entry.access_token }];
  });
}

function pickPage(pages: FacebookPageGrant[], pageId: string | null): FacebookPageGrant {
  if (pageId) {
    const match = pages.find((page) => page.id === pageId);
    if (match) return match;
    throw new PlatformApiError(
      "not_configured",
      "That Page id is not available to this login.",
      "Sign in again and choose a Page this account manages.",
    );
  }
  const only = pages[0];
  if (pages.length === 1 && only) return only;
  if (pages.length === 0) {
    throw new PlatformApiError(
      "not_configured",
      "This login does not manage a Facebook Page.",
      "Sign in with the account that manages the Page.",
    );
  }
  throw new PlatformApiError(
    "not_configured",
    "This login manages more than one Page.",
    "Choose the Page on the settings page.",
  );
}

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
  const token = requirePageToken(connection.credentials.pageAccessToken);
  const page = await fetchPage(token, connection.credentials.pageId);
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
  const token = requirePageToken(connection.credentials.pageAccessToken);
  const today = formatIsoDate(new Date());
  const period = clampLookback(
    query.period,
    daysBefore(today, 730),
    "Facebook Page insights were limited to about two years. The start date was moved forward.",
  );
  const page = await fetchPage(token, connection.credentials.pageId);
  store.save(
    "facebook",
    { ...connection.credentials, pageAccessToken: token, pageId: page.pageId },
    { account: page.account },
  );
  const wantSummary = mode === "analytics" && query.include !== "content";
  const wantContent = mode === "content" || query.include !== "summary";
  const unavailable: UnavailableMetric[] = [
    {
      key: "watch_time_minutes",
      code: "unsupported",
      reason:
        "Facebook account insights are not queried for a single watch-time total here. Video watch time is requested on each video post.",
    },
  ];
  const notes = [
    "Facebook post metrics are lifetime totals for posts published in the range, not activity during the range.",
    "Daily page metrics use Pacific Time. Each insight end_time is the exclusive end of the measured Pacific day, so the date is that day rather than the UTC timestamp.",
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
  const viewErrors: string[] = [];
  const withViews: ContentItem[] = [];
  for (const item of ranked) {
    const videoId = videoIdFrom(
      posts.find((post) => readString(post, "id") === item.id),
    );
    const insights = await postInsights(token, item.id, videoId);
    if (insights.views === null) {
      viewMisses += 1;
      viewErrors.push(
        insights.failure ?? `${item.id}: no post_media_view value`,
      );
    }
    const metrics = [...item.metrics];
    pushLifetime(
      metrics,
      "views",
      "Views",
      insights.views,
      "views",
      "post_media_view",
    );
    pushLifetime(
      metrics,
      "reach",
      "Accounts reached",
      insights.reach,
      "accounts",
      "post_total_media_view_unique",
    );
    pushLifetime(
      metrics,
      "watch_time_minutes",
      "Watch time",
      insights.watchMinutes,
      "minutes",
      "post_video_view_time",
    );
    pushLifetime(
      metrics,
      "average_view_duration_seconds",
      "Average view duration",
      insights.averageSeconds,
      "seconds",
      "post_video_avg_time_watched",
    );
    pushLifetime(
      metrics,
      "video_duration_seconds",
      "Video duration",
      insights.durationSeconds,
      "seconds",
      "length",
    );
    withViews.push({ ...item, metrics });
  }
  if (viewMisses > 0) {
    const denied = viewErrors.some((entry) =>
      entry.includes("permission_denied"),
    );
    unavailable.push({
      key: "views",
      code: denied ? "permission_denied" : "no_data",
      reason: "Facebook did not return post_media_view for every post.",
      detail: viewErrors.join(" "),
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
    "id,message,created_time,permalink_url,status_type,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0),attachments{media_type,type,target{id}}";
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

async function postInsights(
  token: string,
  postId: string,
  videoId: string | null,
): Promise<{
  views: number | null;
  reach: number | null;
  watchMinutes: number | null;
  averageSeconds: number | null;
  durationSeconds: number | null;
  failure: string | null;
}> {
  const names = videoId
    ? [
        "post_media_view",
        "post_total_media_view_unique",
        "post_video_view_time",
        "post_video_avg_time_watched",
      ]
    : ["post_media_view", "post_total_media_view_unique"];
  const result = await fetchInsightMetrics({
    host: FACEBOOK_GRAPH,
    path: `${postId}/insights`,
    token,
    metrics: names,
    params: { period: "lifetime" },
    keyForMetric: (name) => name,
  }).catch((error: unknown) => {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
    const code = error instanceof PlatformApiError ? error.code : "api_error";
    const message =
      error instanceof Error ? error.message : "The insight call failed.";
    return {
      parsed: [],
      unavailable: [],
      failure: `${postId}: ${code}: ${sanitizeMetaMessage(message)}`,
    };
  });
  const read = (name: string): number | null => {
    const insight = insightByName(result.parsed, name);
    return insight?.totalValue ?? summedPoints(insight);
  };
  const watchMs = videoId ? read("post_video_view_time") : null;
  const averageMs = videoId ? read("post_video_avg_time_watched") : null;
  return {
    views: read("post_media_view"),
    reach: read("post_total_media_view_unique"),
    watchMinutes: watchMs === null ? null : watchMs / 60_000,
    averageSeconds: averageMs === null ? null : averageMs / 1000,
    durationSeconds: videoId ? await videoLength(token, videoId) : null,
    failure:
      "failure" in result && typeof result.failure === "string"
        ? result.failure
        : null,
  };
}

async function videoLength(
  token: string,
  videoId: string,
): Promise<number | null> {
  try {
    const body = await graphGet(FACEBOOK_GRAPH, videoId, token, {
      fields: "length",
    });
    return isRecord(body) ? asNumber(body.length) : null;
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
    return null;
  }
}

function videoIdFrom(
  record: Record<string, unknown> | undefined,
): string | null {
  if (
    !record ||
    !isRecord(record.attachments) ||
    !Array.isArray(record.attachments.data)
  )
    return null;
  for (const item of record.attachments.data) {
    if (!isRecord(item) || !isRecord(item.target)) continue;
    const id = readString(item.target, "id");
    const kind = `${readString(item, "media_type") ?? ""} ${readString(item, "type") ?? ""}`;
    if (id && kind.includes("video")) return id;
  }
  return null;
}

function sanitizeMetaMessage(message: string): string {
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .slice(0, 240);
}

function pushLifetime(
  metrics: Metric[],
  key: string,
  label: string,
  value: number | null,
  unit: string,
  source: string,
): void {
  if (value === null) return;
  metrics.push(
    metric({
      key,
      label,
      value,
      unit,
      aggregation: "content_lifetime_sum",
      source,
    }),
  );
}

function requirePageToken(token: string | null): string {
  if (!token) {
    throw new PlatformApiError(
      "not_configured",
      "Facebook is not signed in yet.",
      "Use Sign in on the settings page.",
    );
  }
  return token;
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
