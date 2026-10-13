import type { StoredConnection, YouTubeCredentials } from "../credentials.js";
import { metric, okReport, rankContent, withNotes } from "../report/build.js";
import type {
  AccountProfile,
  ChannelCheck,
  ContentItem,
  Metric,
  PlatformReport,
  UnavailableMetric,
} from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { asNumber, clipText, isRecord, readString } from "../util.js";
import type { AnalyticsQuery, PlatformClient } from "./client.js";
import { mapGoogleError, PlatformApiError } from "./errors.js";
import { requestJson } from "./http.js";
import { rememberAccount, requireConnection } from "./remember.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_NOTE =
  "YouTube Analytics dates are Pacific Time calendar dates. Content is ranked by views during that range, including older videos. Recent Pacific days are often missing until processing finishes.";
const INTENDED_YOUTUBE_HANDLE = "jboive";

const SUMMARY_METRICS =
  "views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost";
const AVERAGE_METRICS = "averageViewDuration,averageViewPercentage";
const VIDEO_METRICS =
  "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares";

export const youtubeClient: PlatformClient = {
  id: "youtube",
  capabilities: [
    "Period views, watch time, likes, comments, shares, and subscriber gain and loss.",
    "Current subscriber count for the authenticated channel.",
    "Videos ranked by views during the range.",
  ],
  limitations: [
    "No account reach metric comparable to Instagram or Facebook.",
    "An API key cannot be used. Period analytics require the channel's OAuth refresh token.",
    "Recent days may be missing until YouTube finishes processing them.",
  ],
  test: testYouTube,
  analytics: (store, query) => loadYouTube(store, query, "analytics"),
  content: (store, query) => loadYouTube(store, query, "content"),
};

export async function exchangeYouTubeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}> {
  const { status, body } = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
      code_verifier: args.codeVerifier,
    }),
  });
  return readGoogleToken(body, status, true);
}

export async function refreshYouTubeCredentials(
  store: CredentialStore,
  force = false,
  failedToken?: string,
): Promise<StoredConnection<"youtube">> {
  return store.withLock("youtube-refresh", async () => {
    const current = requireConnection(store, "youtube");
    if (!force && !youtubeNeedsRefresh(current)) return current;
    if (
      force &&
      failedToken &&
      current.credentials.accessToken &&
      current.credentials.accessToken !== failedToken
    )
      return current;
    const refreshed = await requestRefresh(current.credentials);
    return store.save(
      "youtube",
      {
        ...current.credentials,
        accessToken: refreshed.accessToken,
        refreshToken:
          refreshed.refreshToken ?? current.credentials.refreshToken,
      },
      { account: current.account, tokenExpiresAt: refreshed.expiresAt },
    );
  });
}

async function testYouTube(store: CredentialStore): Promise<AccountProfile> {
  return withYouTube(store, async (token) => {
    const channel = await fetchChannel(token);
    rememberAccount(store, "youtube", channel.account);
    return channel.account;
  });
}

async function loadYouTube(
  store: CredentialStore,
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<PlatformReport> {
  return withYouTube(store, async (token) => {
    const channel = await fetchChannel(token);
    rememberAccount(store, "youtube", channel.account);
    const wantSummary = mode === "analytics" && query.include !== "content";
    const wantContent = mode === "content" || query.include !== "summary";
    const unavailable: UnavailableMetric[] = [
      {
        key: "reach",
        reason:
          "YouTube Analytics does not provide an account reach metric comparable to Instagram or Facebook.",
      },
    ];
    if (channel.hiddenSubscribers) {
      unavailable.push({
        key: "followers",
        reason: "This channel hides its subscriber count.",
      });
    }
    const summary = wantSummary
      ? await loadSummary(token, query, channel, unavailable)
      : undefined;
    const content = wantContent
      ? await loadContent(token, query, channel.account.id, unavailable)
      : undefined;
    const report = okReport({
      platform: "youtube",
      account: channel.account,
      period: withNotes(query.period, [channel.check.match ? YOUTUBE_NOTE : `${YOUTUBE_NOTE} ${channel.check.detail}`]),
      summary: summary?.summary,
      series: summary?.series,
      content,
      unavailable,
    });
    report.channelCheck = channel.check;
    if (!channel.check.match) {
      report.unavailable = [
        ...(report.unavailable ?? []),
        {
          key: "channel",
          code: "no_data",
          reason: channel.check.detail,
          detail: `Authenticated channel ${channel.check.authenticatedChannelId ?? "unknown"}. Intended channel ${channel.check.intendedChannelId ?? "not returned"}. Analytics uses the authenticated channel id.`,
        },
      ];
    }
    return report;
  });
}

async function loadSummary(
  token: string,
  query: AnalyticsQuery,
  channel: ChannelInfo,
  unavailable: UnavailableMetric[],
): Promise<{
  summary: Metric[];
  series: NonNullable<PlatformReport["series"]>;
}> {
  const table = await analyticsQuery(token, {
    ids: `channel==${channel.account.id}`,
    startDate: query.period.start,
    endDate: query.period.end,
    metrics: SUMMARY_METRICS,
    dimensions: "day",
    sort: "day",
  });
  const summary: Metric[] = [];
  if (!channel.hiddenSubscribers && channel.subscribers !== null) {
    summary.push(
      metric({
        key: "followers",
        label: "Subscribers",
        value: channel.subscribers,
        unit: "accounts",
        aggregation: "snapshot",
        source: "statistics.subscriberCount",
      }),
    );
  }
  const views = sumColumn(table, "views");
  const watch = sumColumn(table, "estimatedMinutesWatched");
  const likes = sumColumn(table, "likes");
  const comments = sumColumn(table, "comments");
  const shares = sumColumn(table, "shares");
  const gained = sumColumn(table, "subscribersGained");
  const lost = sumColumn(table, "subscribersLost");
  pushPeriod(summary, unavailable, "views", "Views", views, "views", "views");
  pushPeriod(
    summary,
    unavailable,
    "watch_time_minutes",
    "Watch time",
    watch,
    "minutes",
    "estimatedMinutesWatched",
  );
  pushPeriod(summary, unavailable, "likes", "Likes", likes, "count", "likes");
  pushPeriod(summary, unavailable, "comments", "Comments", comments, "count", "comments");
  pushPeriod(summary, unavailable, "shares", "Shares", shares, "count", "shares");
  pushPeriod(
    summary,
    unavailable,
    "followers_gained",
    "Subscribers gained",
    gained,
    "accounts",
    "subscribersGained",
  );
  pushPeriod(
    summary,
    unavailable,
    "followers_lost",
    "Subscribers lost",
    lost,
    "accounts",
    "subscribersLost",
  );
  const engagementParts = [likes, comments, shares].filter(
    (value): value is number => value !== null,
  );
  if (engagementParts.length > 0) {
    summary.push(
      metric({
        key: "engagements",
        label: "Engagements",
        value: engagementParts.reduce((total, value) => total + value, 0),
        unit: "interactions",
        aggregation: "period_total",
        source: "likes+comments+shares",
      }),
    );
  } else {
    unavailable.push({
      key: "engagements",
      reason:
        "YouTube did not return likes, comments, or shares for this range.",
    });
  }
  const averages = await periodAverages(token, channel.account.id, query.period.start, query.period.end);
  pushAverage(
    summary,
    unavailable,
    "average_view_duration_seconds",
    "Average view duration",
    averages.duration,
    "seconds",
    "averageViewDuration",
    averages.reason,
  );
  pushAverage(
    summary,
    unavailable,
    "average_view_percentage",
    "Average view percentage",
    averages.percentage,
    "percent",
    "averageViewPercentage",
    averages.reason,
  );
  if (table.rows.length === 0) {
    unavailable.push({
      key: "series",
      reason:
        "YouTube returned no daily rows. Totals are zero. Recent days are often missing because Analytics lags.",
    });
  }
  const series = table.rows.flatMap((row) => {
    const date = readCell(row, table.headers, "day");
    if (typeof date !== "string") return [];
    return [
      {
        date,
        metrics: {
          views: asNumber(readCell(row, table.headers, "views")),
          watch_time_minutes: asNumber(
            readCell(row, table.headers, "estimatedMinutesWatched"),
          ),
          engagements: sumKnown([
            asNumber(readCell(row, table.headers, "likes")),
            asNumber(readCell(row, table.headers, "comments")),
            asNumber(readCell(row, table.headers, "shares")),
          ]),
          followers_gained: asNumber(
            readCell(row, table.headers, "subscribersGained"),
          ),
          followers_lost: asNumber(
            readCell(row, table.headers, "subscribersLost"),
          ),
        },
      },
    ];
  });
  return { summary, series };
}

async function loadContent(
  token: string,
  query: AnalyticsQuery,
  channelId: string,
  unavailable: UnavailableMetric[],
): Promise<ContentItem[]> {
  const table = await videoTable(token, query, channelId, unavailable);
  const ids = table.rows.flatMap((row) => {
    const id = readCell(row, table.headers, "video");
    return typeof id === "string" ? [id] : [];
  });
  const snippets = await videoSnippets(token, ids);
  if (ids.length > 0 && snippets.size === 0) {
    unavailable.push({
      key: "content_titles",
      reason:
        "YouTube Analytics returned videos, but their titles could not be loaded.",
    });
  }
  const items = table.rows.flatMap((row) => {
    const id = readCell(row, table.headers, "video");
    if (typeof id !== "string") return [];
    const snippet = snippets.get(id);
    const likes = asNumber(readCell(row, table.headers, "likes"));
    const comments = asNumber(readCell(row, table.headers, "comments"));
    const shares = asNumber(readCell(row, table.headers, "shares"));
    const metrics: Metric[] = [];
    pushContent(
      metrics,
      "views",
      "Views",
      asNumber(readCell(row, table.headers, "views")),
      "views",
      "views",
      "period_total",
    );
    pushContent(
      metrics,
      "watch_time_minutes",
      "Watch time",
      asNumber(readCell(row, table.headers, "estimatedMinutesWatched")),
      "minutes",
      "estimatedMinutesWatched",
      "period_total",
    );
    pushContent(
      metrics,
      "average_view_duration_seconds",
      "Average view duration",
      asNumber(readCell(row, table.headers, "averageViewDuration")),
      "seconds",
      "averageViewDuration",
      "period_average",
    );
    pushContent(
      metrics,
      "average_view_percentage",
      "Average view percentage",
      asNumber(readCell(row, table.headers, "averageViewPercentage")),
      "percent",
      "averageViewPercentage",
      "period_average",
    );
    pushContent(metrics, "likes", "Likes", likes, "count", "likes", "period_total");
    pushContent(metrics, "comments", "Comments", comments, "count", "comments", "period_total");
    pushContent(metrics, "shares", "Shares", shares, "count", "shares", "period_total");
    const parts = [likes, comments, shares].filter(
      (value): value is number => value !== null,
    );
    if (parts.length > 0) {
      metrics.push(
        metric({
          key: "engagements",
          label: "Engagements",
          value: parts.reduce((total, value) => total + value, 0),
          unit: "interactions",
          aggregation: "period_total",
          source: "likes+comments+shares",
        }),
      );
    }
    return [
      {
        id,
        kind: "video",
        title: snippet?.title ? clipText(snippet.title) : id,
        url: `https://www.youtube.com/watch?v=${id}`,
        publishedAt: snippet?.publishedAt ?? null,
        metricWindow: "period" as const,
        metrics,
      },
    ];
  });
  return rankContent(items);
}

async function fetchChannel(token: string): Promise<ChannelInfo> {
  const mineUrl = new URL(`${DATA_API}/channels`);
  mineUrl.searchParams.set("part", "snippet,statistics");
  mineUrl.searchParams.set("mine", "true");
  mineUrl.searchParams.set("maxResults", "50");
  const mine = await googleGet(mineUrl, token);
  const owned = readChannels(mine);
  if (owned.length === 0) {
    throw new PlatformApiError(
      "api_error",
      "YouTube did not return a channel for this token.",
      "Sign in with the channel's Google account.",
    );
  }
  const intended = await lookupHandle(token, INTENDED_YOUTUBE_HANDLE);
  const selected = owned.find((item) => normalizeHandle(item.account.handle) === INTENDED_YOUTUBE_HANDLE) ?? owned[0];
  if (!selected) {
    throw new PlatformApiError("api_error", "YouTube did not return a channel for this token.", "Sign in with the channel's Google account.");
  }
  const authenticatedHandle = normalizeHandle(selected.account.handle);
  const match = authenticatedHandle === INTENDED_YOUTUBE_HANDLE && (!intended || intended.id === selected.account.id);
  const detail = match
    ? `Authenticated channel @${authenticatedHandle} matches @${INTENDED_YOUTUBE_HANDLE}. Analytics queries use channel ${selected.account.id}.`
    : `Authenticated channel is @${authenticatedHandle ?? selected.account.id}, not @${INTENDED_YOUTUBE_HANDLE}. Analytics and channel metadata both use ${selected.account.id}.`;
  return {
    ...selected,
    check: {
      intendedHandle: INTENDED_YOUTUBE_HANDLE,
      authenticatedHandle,
      authenticatedChannelId: selected.account.id,
      intendedChannelId: intended?.id ?? null,
      match,
      detail,
    },
  };
}

async function lookupHandle(token: string, handle: string): Promise<{ id: string } | null> {
  const url = new URL(`${DATA_API}/channels`);
  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", handle);
  try {
    const body = await googleGet(url, token);
    const channels = readChannels(body);
    const id = channels[0]?.account.id;
    return id ? { id } : null;
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid") throw error;
    return null;
  }
}

function readChannels(body: unknown): ChannelInfo[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  return body.items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const statistics = isRecord(item.statistics) ? item.statistics : {};
    const id = readString(item, "id");
    if (!id) return [];
    return [{
      account: {
        id,
        name: readString(snippet, "title") ?? id,
        handle: readString(snippet, "customUrl"),
      },
      subscribers: asNumber(statistics.subscriberCount),
      hiddenSubscribers: statistics.hiddenSubscriberCount === true,
      check: {
        intendedHandle: INTENDED_YOUTUBE_HANDLE,
        authenticatedHandle: null,
        authenticatedChannelId: id,
        intendedChannelId: null,
        match: false,
        detail: "",
      },
    }];
  });
}

function normalizeHandle(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^@/, "").toLowerCase();
}

async function videoSnippets(
  token: string,
  ids: string[],
): Promise<Map<string, { title: string | null; publishedAt: string | null }>> {
  const snippets = new Map<
    string,
    { title: string | null; publishedAt: string | null }
  >();
  if (ids.length === 0) return snippets;
  const url = new URL(`${DATA_API}/videos`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", ids.join(","));
  try {
    const body = await googleGet(url, token);
    if (!isRecord(body) || !Array.isArray(body.items)) return snippets;
    for (const item of body.items) {
      if (!isRecord(item)) continue;
      const id = readString(item, "id");
      if (!id || !isRecord(item.snippet)) continue;
      snippets.set(id, {
        title: readString(item.snippet, "title"),
        publishedAt: readString(item.snippet, "publishedAt"),
      });
    }
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid")
      throw error;
  }
  return snippets;
}

async function analyticsQuery(
  token: string,
  params: Record<string, string>,
): Promise<AnalyticsTable> {
  const url = new URL(ANALYTICS);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const body = await googleGet(url, token);
  return parseTable(body);
}

async function googleGet(url: URL, token: string): Promise<unknown> {
  const { status, body } = await requestJson(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status >= 400) throw mapGoogleError(body, status);
  return body;
}

async function withYouTube<T>(
  store: CredentialStore,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  let current = await ensureYouTubeAccess(store);
  const token = current.credentials.accessToken;
  if (!token)
    throw new PlatformApiError(
      "token_invalid",
      "YouTube did not return an access token.",
      "Sign in again on the settings page.",
    );
  try {
    return await fn(token);
  } catch (error) {
    if (!(error instanceof PlatformApiError) || error.code !== "token_invalid")
      throw error;
    current = await refreshYouTubeCredentials(store, true, token);
    if (!current.credentials.accessToken) {
      throw new PlatformApiError(
        "token_invalid",
        "YouTube did not return an access token.",
        "Sign in again on the settings page.",
      );
    }
    return fn(current.credentials.accessToken);
  }
}

async function ensureYouTubeAccess(
  store: CredentialStore,
): Promise<StoredConnection<"youtube">> {
  const current = requireConnection(store, "youtube");
  if (!youtubeNeedsRefresh(current)) return current;
  return refreshYouTubeCredentials(store);
}

async function requestRefresh(credentials: YouTubeCredentials): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}> {
  if (!credentials.refreshToken) {
    throw new PlatformApiError(
      "not_configured",
      "YouTube does not have a refresh token yet.",
      "Save the client id and secret, then use Sign in on the settings page.",
    );
  }
  const { status, body } = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return readGoogleToken(body, status, true);
}

function readGoogleToken(
  body: unknown,
  status: number,
  refresh: boolean,
): { accessToken: string; refreshToken: string | null; expiresAt: string } {
  if (!isRecord(body) || typeof body.access_token !== "string")
    throw mapGoogleError(body, status || 400);
  const refreshToken =
    typeof body.refresh_token === "string" ? body.refresh_token : null;
  if (!refresh && !refreshToken) {
    throw new PlatformApiError(
      "token_invalid",
      "Google did not return a refresh token.",
      "Remove this app's access at https://myaccount.google.com/permissions and sign in again.",
      status,
    );
  }
  const expiresIn = asNumber(body.expires_in) ?? 3600;
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

function youtubeNeedsRefresh(connection: StoredConnection<"youtube">): boolean {
  if (!connection.credentials.accessToken || !connection.tokenExpiresAt)
    return true;
  const time = Date.parse(connection.tokenExpiresAt);
  if (Number.isNaN(time)) return true;
  return time - Date.now() <= 60_000;
}

function parseTable(body: unknown): AnalyticsTable {
  if (!isRecord(body)) return { headers: [], rows: [] };
  const headers = Array.isArray(body.columnHeaders)
    ? body.columnHeaders.flatMap((header) =>
        isRecord(header) && typeof header.name === "string"
          ? [header.name]
          : [],
      )
    : [];
  const rows = Array.isArray(body.rows)
    ? body.rows.filter((row): row is unknown[] => Array.isArray(row))
    : [];
  return { headers, rows };
}

function sumColumn(table: AnalyticsTable, name: string): number | null {
  if (!table.headers.includes(name)) return null;
  if (table.rows.length === 0) return 0;
  let total = 0;
  for (const row of table.rows)
    total += asNumber(readCell(row, table.headers, name)) ?? 0;
  return total;
}

function readCell(row: unknown[], headers: string[], name: string): unknown {
  const index = headers.indexOf(name);
  if (index < 0) return null;
  return row[index] ?? null;
}

async function periodAverages(
  token: string,
  channelId: string,
  startDate: string,
  endDate: string,
): Promise<{ duration: number | null; percentage: number | null; reason: string | null }> {
  try {
    const table = await analyticsQuery(token, {
      ids: `channel==${channelId}`,
      startDate,
      endDate,
      metrics: AVERAGE_METRICS,
    });
    const row = table.rows[0];
    if (!row) {
      return {
        duration: null,
        percentage: null,
        reason: "YouTube did not return average view duration or percentage for this range.",
      };
    }
    return {
      duration: asNumber(readCell(row, table.headers, "averageViewDuration")),
      percentage: asNumber(readCell(row, table.headers, "averageViewPercentage")),
      reason: null,
    };
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid") throw error;
    return {
      duration: null,
      percentage: null,
      reason: "YouTube did not return averageViewDuration or averageViewPercentage for this range.",
    };
  }
}

async function videoTable(
  token: string,
  query: AnalyticsQuery,
  channelId: string,
  unavailable: UnavailableMetric[],
): Promise<AnalyticsTable> {
  const params = {
    ids: `channel==${channelId}`,
    startDate: query.period.start,
    endDate: query.period.end,
    dimensions: "video",
    sort: "-views",
    maxResults: String(query.contentLimit),
  };
  try {
    return await analyticsQuery(token, { ...params, metrics: VIDEO_METRICS });
  } catch (error) {
    if (error instanceof PlatformApiError && error.code === "token_invalid") throw error;
    unavailable.push({
      key: "average_view_duration_seconds",
      reason: "YouTube rejected average view metrics for videos. Views, watch time, and interactions were loaded without them.",
    });
    return analyticsQuery(token, {
      ...params,
      metrics: "views,estimatedMinutesWatched,likes,comments,shares",
    });
  }
}

function pushAverage(
  summary: Metric[],
  unavailable: UnavailableMetric[],
  key: string,
  label: string,
  value: number | null,
  unit: string,
  source: string,
  reason: string | null,
): void {
  if (value === null) {
    unavailable.push({
      key,
      reason: reason ?? `YouTube did not return ${source} for this range.`,
    });
    return;
  }
  summary.push(metric({ key, label, value, unit, aggregation: "period_average", source }));
}

function pushPeriod(
  summary: Metric[],
  unavailable: UnavailableMetric[],
  key: string,
  label: string,
  value: number | null,
  unit: string,
  source: string,
): void {
  if (value === null) {
    unavailable.push({
      key,
      reason: `YouTube did not return ${source} for this range.`,
    });
    return;
  }
  summary.push(
    metric({ key, label, value, unit, aggregation: "period_total", source }),
  );
}

function pushContent(
  metrics: Metric[],
  key: string,
  label: string,
  value: number | null,
  unit: string,
  source: string,
  aggregation: "period_total" | "period_average",
): void {
  if (value === null) return;
  metrics.push(metric({ key, label, value, unit, aggregation, source }));
}

function sumKnown(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

type ChannelInfo = {
  account: AccountProfile;
  subscribers: number | null;
  hiddenSubscribers: boolean;
  check: ChannelCheck;
};

type AnalyticsTable = {
  headers: string[];
  rows: unknown[][];
};
