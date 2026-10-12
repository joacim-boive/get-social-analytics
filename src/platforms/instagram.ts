import type { StoredConnection } from "../credentials.js";
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
import { requestJson } from "./http.js";
import {
  fetchInsightMetrics,
  graphGet,
  insightByName,
  INSTAGRAM_GRAPH,
  nextCursor,
  readDataList,
  seriesFromPoints,
  summedPoints,
  type ParsedInsight,
} from "./insights.js";
import { rememberAccount, requireConnection } from "./remember.js";

const ACCOUNT_METRICS = [
  "reach",
  "views",
  "accounts_engaged",
  "total_interactions",
] as const;
const MEDIA_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
];

const EMPTY_INSIGHTS =
  "Instagram returned no account insights for this range. Accounts with fewer than 100 followers often get an empty set instead of zeros.";

export const instagramClient: PlatformClient = {
  id: "instagram",
  capabilities: [
    "Account reach, views, and engagements for a range up to about 90 days.",
    "Current follower count.",
    "Lifetime performance for media published in the range.",
  ],
  limitations: [
    "No watch time.",
    "Daily follower totals only cover about 30 days.",
    "Media counts are lifetime totals, not activity during the range.",
    "A follower gain and loss split is included only when Instagram labels follows and unfollows explicitly.",
  ],
  test: testInstagram,
  analytics: (store, query) => loadInstagram(store, query, "analytics"),
  content: (store, query) => loadInstagram(store, query, "content"),
};

async function testInstagram(store: CredentialStore): Promise<AccountProfile> {
  return withInstagramToken(store, async (token) => {
    const profile = await fetchProfile(token);
    rememberAccount(store, "instagram", profile.account);
    return profile.account;
  });
}

async function loadInstagram(
  store: CredentialStore,
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<PlatformReport> {
  return withInstagramToken(store, async (token) => {
    const today = formatIsoDate(new Date());
    const period = clampLookback(
      query.period,
      daysBefore(today, 90),
      "Instagram account insights are only stored for about 90 days. The start date was moved forward.",
    );
    const profile = await fetchProfile(token);
    rememberAccount(store, "instagram", profile.account);
    const wantSummary = mode === "analytics" && query.include !== "content";
    const wantContent = mode === "content" || query.include !== "summary";
    const unavailable: UnavailableMetric[] = [
      {
        key: "watch_time_minutes",
        reason: "Instagram does not provide watch time.",
      },
    ];
    const notes = [
      "Instagram media metrics are lifetime totals for items published in the range, not activity during the range.",
    ];
    let summary: Metric[] | undefined;
    let series: ReturnType<typeof seriesFromPoints> | undefined;
    if (wantSummary) {
      const built = await loadSummary(
        token,
        profile,
        period,
        today,
        unavailable,
      );
      summary = built.summary;
      series = built.series;
      notes.push(...built.notes);
    }
    const content = wantContent
      ? await loadContent(
          token,
          profile.account.id,
          period,
          query.contentLimit,
          unavailable,
        )
      : undefined;
    return okReport({
      platform: "instagram",
      account: profile.account,
      period: withNotes(period, notes),
      summary,
      series,
      content,
      unavailable,
    });
  });
}

async function loadSummary(
  token: string,
  profile: { account: AccountProfile; followers: number | null },
  period: AnalyticsQuery["period"],
  today: string,
  unavailable: UnavailableMetric[],
): Promise<{
  summary: Metric[];
  series: ReturnType<typeof seriesFromPoints>;
  notes: string[];
}> {
  const notes: string[] = [];
  const range = periodUnixRange(period);
  const accountInsights = await fetchInsightMetrics({
    host: INSTAGRAM_GRAPH,
    path: `${profile.account.id}/insights`,
    token,
    metrics: [...ACCOUNT_METRICS],
    params: {
      period: "day",
      metric_type: "total_value",
      since: String(range.since),
      until: String(range.until),
    },
    keyForMetric: instagramMetricKey,
  });
  unavailable.push(...accountInsights.unavailable);
  if (
    accountInsights.parsed.length === 0 &&
    accountInsights.unavailable.length === 0
  ) {
    for (const name of ACCOUNT_METRICS) {
      unavailable.push({
        key: instagramMetricKey(name),
        reason: EMPTY_INSIGHTS,
      });
    }
  }

  const summary: Metric[] = [];
  if (profile.followers !== null) {
    summary.push(
      metric({
        key: "followers",
        label: "Followers",
        value: profile.followers,
        unit: "accounts",
        aggregation: "snapshot",
        source: "followers_count",
      }),
    );
  } else {
    unavailable.push({
      key: "followers",
      reason: "Instagram did not return a follower count for this account.",
    });
  }

  pushTotal(
    summary,
    unavailable,
    insightByName(accountInsights.parsed, "views"),
    "views",
    "Views",
    "views",
  );
  pushTotal(
    summary,
    unavailable,
    insightByName(accountInsights.parsed, "reach"),
    "reach",
    "Accounts reached",
    "accounts",
  );
  pushTotal(
    summary,
    unavailable,
    insightByName(accountInsights.parsed, "total_interactions"),
    "engagements",
    "Engagements",
    "interactions",
  );
  const engaged = insightByName(accountInsights.parsed, "accounts_engaged");
  if (engaged?.totalValue !== null && engaged?.totalValue !== undefined) {
    summary.push(
      metric({
        key: "accounts_engaged",
        label: "Accounts engaged",
        value: engaged.totalValue,
        unit: "accounts",
        aggregation: "period_total",
        source: "accounts_engaged",
      }),
    );
  }

  const follows = await fetchInsightMetrics({
    host: INSTAGRAM_GRAPH,
    path: `${profile.account.id}/insights`,
    token,
    metrics: ["follows_and_unfollows"],
    params: {
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      since: String(range.since),
      until: String(range.until),
    },
    keyForMetric: () => "followers_gained",
  });
  const followMetric = insightByName(follows.parsed, "follows_and_unfollows");
  const mapped = mapFollowBreakdown(followMetric?.breakdowns ?? []);
  if (mapped.gained !== null) {
    summary.push(
      metric({
        key: "followers_gained",
        label: "Followers gained",
        value: mapped.gained,
        unit: "accounts",
        aggregation: "period_total",
        source: "follows_and_unfollows",
      }),
    );
  }
  if (mapped.lost !== null) {
    summary.push(
      metric({
        key: "followers_lost",
        label: "Followers lost",
        value: mapped.lost,
        unit: "accounts",
        aggregation: "period_total",
        source: "follows_and_unfollows",
      }),
    );
  }
  if (mapped.reason && mapped.gained === null)
    unavailable.push({ key: "followers_gained", reason: mapped.reason });
  if (mapped.reason && mapped.lost === null)
    unavailable.push({ key: "followers_lost", reason: mapped.reason });

  const followerStart = daysBefore(today, 29);
  const seriesStart =
    period.start < followerStart ? followerStart : period.start;
  if (period.start < followerStart) {
    notes.push(
      "Daily follower totals from Instagram only cover about the last 30 days.",
    );
  }
  const followerRange = periodUnixRange({
    start: seriesStart,
    end: period.end,
  });
  const followerSeries = await fetchInsightMetrics({
    host: INSTAGRAM_GRAPH,
    path: `${profile.account.id}/insights`,
    token,
    metrics: ["follower_count"],
    params: {
      period: "day",
      since: String(followerRange.since),
      until: String(followerRange.until),
    },
    keyForMetric: () => "followers",
  });
  const followerPoints = insightByName(followerSeries.parsed, "follower_count");
  if (followerPoints && followerPoints.points.length > 0) {
    notes.push(
      "series.followers is the follower total at the end of each day, not new followers.",
    );
  }
  return {
    summary,
    series: seriesFromPoints([
      { key: "followers", points: followerPoints?.points ?? [] },
    ]),
    notes,
  };
}

async function loadContent(
  token: string,
  userId: string,
  period: AnalyticsQuery["period"],
  contentLimit: number,
  unavailable: UnavailableMetric[],
): Promise<ContentItem[]> {
  const media = await listMedia(token, userId, period);
  const shortlist = media.slice(0, 40);
  let insightMisses = 0;
  const items: ContentItem[] = [];
  for (const item of shortlist) {
    const mediaId = readString(item, "id");
    if (!mediaId) continue;
    const insights = await mediaInsightSafe(token, mediaId);
    if (insights === null) insightMisses += 1;
    items.push(toContentItem(item, insights ?? []));
  }
  if (insightMisses > 0) {
    unavailable.push({
      key: "content_insights",
      reason:
        "Some media insight calls failed. Those posts use the like and comment counts on the media object.",
    });
  }
  return rankContent(items).slice(0, contentLimit);
}

async function listMedia(
  token: string,
  userId: string,
  period: AnalyticsQuery["period"],
): Promise<MediaRecord[]> {
  const collected: MediaRecord[] = [];
  let after: string | null = null;
  for (let page = 0; page < 6; page += 1) {
    const params: Record<string, string> = {
      fields:
        "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
      limit: "25",
    };
    if (after) params.after = after;
    const body = await graphGet(
      INSTAGRAM_GRAPH,
      `${userId}/media`,
      token,
      params,
    );
    let reachedOlder = false;
    for (const record of readDataList(body)) {
      const timestamp = readString(record, "timestamp");
      if (timestamp && isBeforePeriod(timestamp, period.start)) {
        reachedOlder = true;
        break;
      }
      if (!timestamp || isWithinPeriod(timestamp, period))
        collected.push(record);
    }
    if (reachedOlder) break;
    after = nextCursor(body);
    if (!after) break;
  }
  return collected;
}

function isBeforePeriod(timestamp: string, start: string): boolean {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  return formatIsoDate(date) < start;
}

async function mediaInsightSafe(
  token: string,
  mediaId: string,
): Promise<ParsedInsight[] | null> {
  try {
    const result = await fetchInsightMetrics({
      host: INSTAGRAM_GRAPH,
      path: `${mediaId}/insights`,
      token,
      metrics: MEDIA_METRICS,
      params: {},
      keyForMetric: (name) => name,
    });
    return result.parsed;
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
    return null;
  }
}

function toContentItem(
  record: Record<string, unknown>,
  insights: ParsedInsight[],
): ContentItem {
  const viewMetric = insightByName(insights, "views");
  const views = viewMetric?.totalValue ?? summedPoints(viewMetric);
  const likes =
    insightByName(insights, "likes")?.totalValue ?? asNumber(record.like_count);
  const comments =
    insightByName(insights, "comments")?.totalValue ??
    asNumber(record.comments_count);
  const shares = insightByName(insights, "shares")?.totalValue ?? null;
  const saves = insightByName(insights, "saved")?.totalValue ?? null;
  const reach = insightByName(insights, "reach")?.totalValue ?? null;
  const metrics: Metric[] = [];
  pushContentMetric(metrics, "views", "Views", views, "views");
  pushContentMetric(metrics, "reach", "Accounts reached", reach, "reach");
  pushContentMetric(
    metrics,
    "likes",
    "Likes",
    likes,
    likes === asNumber(record.like_count) ? "like_count" : "likes",
  );
  pushContentMetric(metrics, "comments", "Comments", comments, "comments");
  pushContentMetric(metrics, "shares", "Shares", shares, "shares");
  pushContentMetric(metrics, "saves", "Saves", saves, "saved");
  const engagementParts = [likes, comments, shares, saves].filter(
    (value): value is number => value !== null,
  );
  if (engagementParts.length > 0) {
    metrics.push(
      metric({
        key: "engagements",
        label: "Engagements",
        value: engagementParts.reduce((total, value) => total + value, 0),
        unit: "interactions",
        aggregation: "content_lifetime_sum",
        source: "likes+comments+shares+saved",
      }),
    );
  }
  const caption = readString(record, "caption");
  return {
    id: readString(record, "id") ?? "unknown",
    kind: (
      readString(record, "media_product_type") ??
      readString(record, "media_type") ??
      "media"
    ).toLowerCase(),
    title: caption ? clipText(caption) : "(no caption)",
    url: readString(record, "permalink"),
    publishedAt: readString(record, "timestamp"),
    metricWindow: "lifetime",
    metrics,
  };
}

type MediaRecord = Record<string, unknown>;

async function fetchProfile(
  token: string,
): Promise<{ account: AccountProfile; followers: number | null }> {
  let body: unknown;
  try {
    body = await graphGet(INSTAGRAM_GRAPH, "me", token, {
      fields: "user_id,username,name,followers_count",
    });
  } catch (error) {
    if (!(error instanceof PlatformApiError) || error.code === "token_invalid")
      throw error;
    body = await graphGet(INSTAGRAM_GRAPH, "me", token, {
      fields: "id,username",
    });
  }
  if (!isRecord(body)) {
    throw new PlatformApiError(
      "api_error",
      "Instagram returned an unreadable profile.",
      "Test the connection again.",
    );
  }
  const id = readString(body, "user_id") ?? readString(body, "id");
  if (!id)
    throw new PlatformApiError(
      "api_error",
      "Instagram did not return an account id.",
      "Paste a token for a professional account.",
    );
  const username = readString(body, "username");
  return {
    account: {
      id,
      name: readString(body, "name") ?? username ?? id,
      handle: username,
    },
    followers: asNumber(body.followers_count),
  };
}

async function withInstagramToken<T>(
  store: CredentialStore,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const current = requireConnection(store, "instagram");
  const initial = await maybeRefreshInstagram(store, current);
  try {
    return await fn(initial.credentials.accessToken);
  } catch (error) {
    if (!(error instanceof PlatformApiError) || error.code !== "token_invalid")
      throw error;
    const refreshed = await refreshInstagramCredentials(
      store,
      initial.credentials.accessToken,
    );
    return fn(refreshed.credentials.accessToken);
  }
}

async function maybeRefreshInstagram(
  store: CredentialStore,
  connection: StoredConnection<"instagram">,
): Promise<StoredConnection<"instagram">> {
  if (!instagramExpiresSoon(connection.tokenExpiresAt)) return connection;
  return refreshInstagramCredentials(store);
}

export async function refreshInstagramCredentials(
  store: CredentialStore,
  failedToken?: string,
): Promise<StoredConnection<"instagram">> {
  return store.withLock("instagram-refresh", async () => {
    const current = requireConnection(store, "instagram");
    if (
      failedToken &&
      current.credentials.accessToken !== failedToken &&
      !instagramExpiresSoon(current.tokenExpiresAt)
    ) {
      return current;
    }
    try {
      const refreshed = await postInstagramToken(
        "https://graph.instagram.com/refresh_access_token",
        {
          grant_type: "ig_refresh_token",
          access_token: current.credentials.accessToken,
        },
      );
      return store.save(
        "instagram",
        { ...current.credentials, accessToken: refreshed.accessToken },
        { account: current.account, tokenExpiresAt: refreshed.expiresAt },
      );
    } catch (refreshError) {
      try {
        const exchanged = await postInstagramToken(
          "https://graph.instagram.com/access_token",
          {
            grant_type: "ig_exchange_token",
            client_secret: current.credentials.appSecret,
            access_token: current.credentials.accessToken,
          },
        );
        return store.save(
          "instagram",
          { ...current.credentials, accessToken: exchanged.accessToken },
          { account: current.account, tokenExpiresAt: exchanged.expiresAt },
        );
      } catch {
        if (refreshError instanceof PlatformApiError) throw refreshError;
        throw refreshError;
      }
    }
  });
}

async function postInstagramToken(
  url: string,
  params: Record<string, string>,
): Promise<{ accessToken: string; expiresAt: string }> {
  const endpoint = new URL(url);
  for (const [key, value] of Object.entries(params))
    endpoint.searchParams.set(key, value);
  const { status, body } = await requestJson(endpoint.toString());
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw mapTokenError(body, status);
  }
  const expiresIn = asNumber(body.expires_in) ?? 60 * 24 * 60 * 60;
  return {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

function mapTokenError(body: unknown, status: number): PlatformApiError {
  if (isRecord(body) && isRecord(body.error))
    return mapMetaError(body, status || 400);
  return new PlatformApiError(
    "token_invalid",
    "Instagram did not refresh the token.",
    "Paste a new long-lived token on the settings page.",
    status,
  );
}

function instagramExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  if (Number.isNaN(time)) return false;
  return time - Date.now() <= 7 * 24 * 60 * 60 * 1000;
}

function instagramMetricKey(name: string): string {
  if (name === "total_interactions") return "engagements";
  if (name === "accounts_engaged") return "accounts_engaged";
  return name;
}

function pushTotal(
  summary: Metric[],
  unavailable: UnavailableMetric[],
  insight: ParsedInsight | null,
  key: string,
  label: string,
  unit: string,
): void {
  const value = insight?.totalValue ?? null;
  if (value === null) {
    if (!unavailable.some((item) => item.key === key)) {
      unavailable.push({
        key,
        reason: insight
          ? "Instagram did not return a total for this metric."
          : EMPTY_INSIGHTS,
      });
    }
    return;
  }
  summary.push(
    metric({
      key,
      label,
      value,
      unit,
      aggregation: "period_total",
      source: insight?.name ?? key,
    }),
  );
}

function pushContentMetric(
  metrics: Metric[],
  key: string,
  label: string,
  value: number | null,
  source: string,
): void {
  if (value === null) return;
  const unit =
    key === "views" ? "views" : key === "reach" ? "accounts" : "count";
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

function mapFollowBreakdown(
  breakdowns: Array<{ dimension: string; value: number }>,
): {
  gained: number | null;
  lost: number | null;
  reason: string | null;
} {
  let gained: number | null = null;
  let lost: number | null = null;
  let ambiguous = false;
  for (const item of breakdowns) {
    if (item.dimension === "FOLLOW" || item.dimension === "FOLLOWS")
      gained = item.value;
    else if (item.dimension === "UNFOLLOW" || item.dimension === "UNFOLLOWS")
      lost = item.value;
    else if (item.dimension === "FOLLOWER" || item.dimension === "NON_FOLLOWER")
      ambiguous = true;
  }
  if (gained === null && lost === null) {
    return {
      gained,
      lost,
      reason: ambiguous
        ? "Instagram broke follows down by follower versus non-follower, which is not a count of new follows and unfollows."
        : "Instagram did not break follows into new follows and unfollows.",
    };
  }
  return { gained, lost, reason: null };
}
