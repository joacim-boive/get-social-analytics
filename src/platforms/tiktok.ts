import type { CredentialStore } from "../store.js";
import type { TikTokCredentials, StoredConnection } from "../credentials.js";
import { metric, okReport, rankContent, withNotes } from "../report/build.js";
import { formatIsoDate, isWithinPeriod } from "../report/period.js";
import type { AccountProfile, ContentItem, Metric, PlatformReport, UnavailableMetric } from "../report/types.js";
import { asNumber, clipText, isRecord, readString } from "../util.js";
import { mapTikTokError, PlatformApiError } from "./errors.js";
import { requestJson } from "./http.js";
import { rememberAccount, requireConnection } from "./remember.js";
import type { AnalyticsQuery, PlatformClient } from "./client.js";

const API = "https://open.tiktokapis.com";
const TIKTOK_NOTE =
  "TikTok has no period analytics. Followers are a current snapshot. Views and engagements are lifetime totals of videos published in the range, not activity during the range.";

export const tiktokClient: PlatformClient = {
  id: "tiktok",
  capabilities: [
    "Current follower, following, like, and video counts.",
    "Lifetime view, like, comment, and share counts for public videos published in the range.",
  ],
  limitations: [
    "No views, reach, or follower change for a date range.",
    "Video stats are lifetime totals. A last-7-days request means videos posted in those 7 days.",
    "Only public videos the video.list scope can read are included.",
  ],
  test: testTikTok,
  analytics: (store, query) => loadTikTok(store, query, "analytics"),
  content: (store, query) => loadTikTok(store, query, "content"),
};

export async function exchangeTikTokCode(args: {
  clientKey: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; refreshToken: string; openId: string | null; expiresAt: string }> {
  const { status, body } = await requestJson(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: args.clientKey,
      client_secret: args.clientSecret,
      code: args.code,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    }),
  });
  return readTokenPayload(body, status);
}

export async function refreshTikTokCredentials(
  store: CredentialStore,
  force = false,
  failedToken?: string,
): Promise<StoredConnection<"tiktok">> {
  return store.withLock("tiktok-refresh", async () => {
    const current = requireConnection(store, "tiktok");
    if (!force && !tiktokNeedsRefresh(current)) return current;
    if (force && failedToken && current.credentials.accessToken !== failedToken) return current;
    const refreshed = await requestRefresh(current.credentials);
    return store.save(
      "tiktok",
      {
        ...current.credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        openId: refreshed.openId ?? current.credentials.openId,
      },
      { account: current.account, tokenExpiresAt: refreshed.expiresAt },
    );
  });
}

async function testTikTok(store: CredentialStore): Promise<AccountProfile> {
  return withTikTok(store, async (connection) => {
    const profile = await fetchUser(connection.credentials.accessToken);
    rememberAccount(store, "tiktok", profile.account);
    return profile.account;
  });
}

async function loadTikTok(
  store: CredentialStore,
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<PlatformReport> {
  return withTikTok(store, async (connection) => {
    const token = connection.credentials.accessToken;
    const profile = await fetchUser(token);
    rememberAccount(store, "tiktok", profile.account);
    const wantSummary = mode === "analytics" && query.include !== "content";
    const wantContent = mode === "content" || query.include !== "summary";
    const unavailable: UnavailableMetric[] = [
      { key: "reach", reason: "TikTok Display API does not provide reach." },
      { key: "watch_time_minutes", reason: "TikTok Display API does not provide watch time." },
      { key: "followers_gained", reason: "TikTok only returns the current follower count, not follows during a range." },
      { key: "followers_lost", reason: "TikTok only returns the current follower count, not unfollows during a range." },
    ];
    const videos = wantSummary || wantContent ? await listVideos(token, query.period) : { items: [], truncated: false };
    if (videos.truncated) {
      unavailable.push({
        key: "content",
        reason: "TikTok listing stopped after 200 recent videos. Older posts in this range may be missing.",
      });
    }
    const summary = wantSummary ? buildSummary(profile, videos.items) : undefined;
    const content = wantContent ? rankContent(videos.items.map(toContentItem)).slice(0, query.contentLimit) : undefined;
    return okReport({
      platform: "tiktok",
      account: profile.account,
      period: withNotes(query.period, [TIKTOK_NOTE]),
      summary,
      content,
      unavailable,
    });
  });
}

function buildSummary(
  profile: { account: AccountProfile; followers: number | null; likes: number | null; videos: number | null },
  items: TikTokVideo[],
): Metric[] {
  const summary: Metric[] = [];
  if (profile.followers !== null) {
    summary.push(
      metric({
        key: "followers",
        label: "Followers",
        value: profile.followers,
        unit: "accounts",
        aggregation: "snapshot",
        source: "follower_count",
      }),
    );
  }
  const views = sumPresent(items.map((item) => item.viewCount), items.length === 0);
  const engagements = sumPresent(
    items.flatMap((item) => [item.likeCount, item.commentCount, item.shareCount]),
    items.length === 0,
  );
  if (views !== null) {
    summary.push(
      metric({
        key: "views",
        label: "Views",
        value: views,
        unit: "views",
        aggregation: "content_lifetime_sum",
        source: "view_count",
      }),
    );
  }
  if (engagements !== null) {
    summary.push(
      metric({
        key: "engagements",
        label: "Engagements",
        value: engagements,
        unit: "interactions",
        aggregation: "content_lifetime_sum",
        source: "like_count+comment_count+share_count",
      }),
    );
  }
  return summary;
}

function sumPresent(values: Array<number | null>, emptyIsZero: boolean): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return emptyIsZero ? 0 : null;
  return present.reduce((total, value) => total + value, 0);
}

async function listVideos(token: string, period: AnalyticsQuery["period"]): Promise<{ items: TikTokVideo[]; truncated: boolean }> {
  const items: TikTokVideo[] = [];
  let cursor: number | null = null;
  let truncated = false;
  for (let page = 0; page < 10; page += 1) {
    const payload: { max_count: number; cursor?: number } = { max_count: 20 };
    if (cursor !== null) payload.cursor = cursor;
    const body = await tiktokPost("/v2/video/list/", token, "id,title,video_description,create_time,share_url,like_count,comment_count,share_count,view_count", payload);
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    const videos = data && Array.isArray(data.videos) ? data.videos.filter(isRecord) : [];
    let reachedOlder = false;
    for (const video of videos) {
      const created = asNumber(video.create_time);
      if (created === null) continue;
      const published = new Date(created * 1000).toISOString();
      if (formatIsoDate(new Date(created * 1000)) < period.start) {
        reachedOlder = true;
        break;
      }
      if (isWithinPeriod(published, period)) items.push(toVideo(video, published));
    }
    if (reachedOlder) break;
    const hasMore = data?.has_more === true;
    const next = data ? asNumber(data.cursor) : null;
    if (!hasMore || next === null) break;
    cursor = next;
    if (page === 9) truncated = true;
  }
  return { items, truncated };
}

function toVideo(record: Record<string, unknown>, publishedAt: string): TikTokVideo {
  return {
    id: readString(record, "id") ?? "unknown",
    title: readString(record, "title") ?? readString(record, "video_description"),
    url: readString(record, "share_url"),
    publishedAt,
    viewCount: asNumber(record.view_count),
    likeCount: asNumber(record.like_count),
    commentCount: asNumber(record.comment_count),
    shareCount: asNumber(record.share_count),
  };
}

function toContentItem(video: TikTokVideo): ContentItem {
  const metrics: Metric[] = [];
  pushCount(metrics, "views", "Views", video.viewCount, "views", "view_count");
  pushCount(metrics, "likes", "Likes", video.likeCount, "count", "like_count");
  pushCount(metrics, "comments", "Comments", video.commentCount, "count", "comment_count");
  pushCount(metrics, "shares", "Shares", video.shareCount, "count", "share_count");
  const parts = [video.likeCount, video.commentCount, video.shareCount].filter((value): value is number => value !== null);
  if (parts.length > 0) {
    metrics.push(
      metric({
        key: "engagements",
        label: "Engagements",
        value: parts.reduce((total, value) => total + value, 0),
        unit: "interactions",
        aggregation: "content_lifetime_sum",
        source: "like_count+comment_count+share_count",
      }),
    );
  }
  return {
    id: video.id,
    kind: "video",
    title: video.title ? clipText(video.title) : "(no title)",
    url: video.url,
    publishedAt: video.publishedAt,
    metricWindow: "lifetime",
    metrics,
  };
}

async function fetchUser(token: string): Promise<{ account: AccountProfile; followers: number | null; likes: number | null; videos: number | null }> {
  let body = await tiktokGet("/v2/user/info/", token, "open_id,display_name,username,follower_count,following_count,likes_count,video_count");
  if (isScopeError(body)) {
    body = await tiktokGet("/v2/user/info/", token, "open_id,display_name,follower_count,likes_count,video_count");
  }
  assertTikTokOk(200, body);
  const user = isRecord(body) && isRecord(body.data) && isRecord(body.data.user) ? body.data.user : null;
  if (!user) throw new PlatformApiError("api_error", "TikTok returned an unreadable profile.", "Test the connection again.");
  const id = readString(user, "open_id") ?? "tiktok-user";
  const username = readString(user, "username");
  const name = readString(user, "display_name") ?? username ?? id;
  return {
    account: { id, name, handle: username },
    followers: asNumber(user.follower_count),
    likes: asNumber(user.likes_count),
    videos: asNumber(user.video_count),
  };
}

async function withTikTok<T>(store: CredentialStore, fn: (connection: StoredConnection<"tiktok">) => Promise<T>): Promise<T> {
  let current = await ensureTikTokAccess(store);
  try {
    return await fn(current);
  } catch (error) {
    if (!(error instanceof PlatformApiError) || error.code !== "token_invalid") throw error;
    current = await refreshTikTokCredentials(store, true, current.credentials.accessToken);
    return fn(current);
  }
}

async function ensureTikTokAccess(store: CredentialStore): Promise<StoredConnection<"tiktok">> {
  const current = requireConnection(store, "tiktok");
  if (!tiktokNeedsRefresh(current)) return current;
  return refreshTikTokCredentials(store);
}

async function requestRefresh(credentials: TikTokCredentials): Promise<{ accessToken: string; refreshToken: string; openId: string | null; expiresAt: string }> {
  const { status, body } = await requestJson(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: credentials.clientKey,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });
  return readTokenPayload(body, status);
}

function readTokenPayload(body: unknown, status: number): { accessToken: string; refreshToken: string; openId: string | null; expiresAt: string } {
  const record = isRecord(body) && isRecord(body.data) && typeof body.data.access_token === "string" ? body.data : body;
  if (!isRecord(record) || typeof record.access_token !== "string" || typeof record.refresh_token !== "string") {
    throw mapTikTokError(body, status || 400);
  }
  const expiresIn = asNumber(record.expires_in) ?? 86_400;
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    openId: readString(record, "open_id"),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function tiktokGet(path: string, token: string, fields: string): Promise<unknown> {
  const url = new URL(`${API}${path}`);
  url.searchParams.set("fields", fields);
  const { status, body } = await requestJson(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (isScopeError(body)) return body;
  assertTikTokOk(status, body);
  return body;
}

async function tiktokPost(path: string, token: string, fields: string, payload: unknown): Promise<unknown> {
  const url = new URL(`${API}${path}`);
  url.searchParams.set("fields", fields);
  const { status, body } = await requestJson(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assertTikTokOk(status, body);
  return body;
}

function assertTikTokOk(status: number, body: unknown): void {
  const code = tiktokCode(body);
  if (status >= 400 || (code !== null && code !== "ok")) throw mapTikTokError(body, status || 400);
}

function isScopeError(body: unknown): boolean {
  return tiktokCode(body) === "scope_not_authorized";
}

function tiktokCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error)) return readString(body.error, "code");
  return null;
}

function tiktokNeedsRefresh(connection: StoredConnection<"tiktok">): boolean {
  if (!connection.tokenExpiresAt) return false;
  const time = Date.parse(connection.tokenExpiresAt);
  if (Number.isNaN(time)) return true;
  return time - Date.now() <= 5 * 60 * 1000;
}

function pushCount(metrics: Metric[], key: string, label: string, value: number | null, unit: string, source: string): void {
  if (value === null) return;
  metrics.push(metric({ key, label, value, unit, aggregation: "content_lifetime_sum", source }));
}

type TikTokVideo = {
  id: string;
  title: string | null;
  url: string | null;
  publishedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
};
