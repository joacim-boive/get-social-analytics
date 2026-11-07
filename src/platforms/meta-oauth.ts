import { asNumber, isRecord, readString } from "../util.js";
import { mapMetaError, PlatformApiError } from "./errors.js";
import { FACEBOOK_GRAPH, graphGet } from "./insights.js";
import { requestJson } from "./http.js";

const INSTAGRAM_SCOPES = "instagram_business_basic,instagram_business_manage_insights";
const FACEBOOK_SCOPES =
  "pages_show_list,pages_read_engagement,pages_read_user_content,read_insights";

export type FacebookPageChoice = {
  id: string;
  name: string;
  accessToken: string;
};

export type ExchangedMetaToken = {
  accessToken: string;
  expiresAt: string;
};

export function instagramAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES);
  url.searchParams.set("state", args.state);
  url.searchParams.set("enable_fb_login", "0");
  return url.toString();
}

export function facebookAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://www.facebook.com/v26.0/dialog/oauth");
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FACEBOOK_SCOPES);
  url.searchParams.set("state", args.state);
  return url.toString();
}

export async function exchangeInstagramCode(args: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<ExchangedMetaToken> {
  const { status, body } = await requestJson("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: args.appId,
      client_secret: args.appSecret,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
      code: stripCode(args.code),
    }),
  });
  const shortLived = readAccessToken(body);
  if (!shortLived) throw metaFailure(body, status, "Instagram did not return an access token.");
  return exchangeLongLivedInstagram(args.appSecret, shortLived);
}

export async function exchangeFacebookCode(args: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<FacebookPageChoice[]> {
  const { status, body } = await requestJson(
    tokenUrl({
      client_id: args.appId,
      client_secret: args.appSecret,
      redirect_uri: args.redirectUri,
      code: stripCode(args.code),
    }),
  );
  const shortLived = readAccessToken(body);
  if (!shortLived) throw metaFailure(body, status, "Facebook did not return an access token.");
  const longLived = await exchangeLongLivedFacebook(args.appId, args.appSecret, shortLived);
  return listFacebookPages(longLived.accessToken);
}

export function encodeFacebookPages(pages: FacebookPageChoice[]): string {
  return JSON.stringify({ kind: "facebook-pages", pages });
}

export function parseFacebookPages(value: string): FacebookPageChoice[] | null {
  if (!value.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== "facebook-pages" || !Array.isArray(parsed.pages)) {
    return null;
  }
  const pages: FacebookPageChoice[] = [];
  for (const entry of parsed.pages) {
    if (!isRecord(entry)) return null;
    const id = readString(entry, "id");
    const accessToken = readString(entry, "accessToken");
    if (!id || !accessToken) return null;
    pages.push({
      id,
      name: readString(entry, "name") ?? id,
      accessToken,
    });
  }
  return pages.length > 0 ? pages : null;
}

async function exchangeLongLivedInstagram(
  appSecret: string,
  accessToken: string,
): Promise<ExchangedMetaToken> {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", accessToken);
  const { status, body } = await requestJson(url.toString());
  const token = readAccessToken(body);
  if (!token) throw metaFailure(body, status, "Instagram did not return a long-lived token.");
  return { accessToken: token, expiresAt: expiresAt(body, 60 * 24 * 60 * 60) };
}

async function exchangeLongLivedFacebook(
  appId: string,
  appSecret: string,
  accessToken: string,
): Promise<ExchangedMetaToken> {
  const { status, body } = await requestJson(
    tokenUrl({
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: accessToken,
    }),
  );
  const token = readAccessToken(body);
  if (!token) throw metaFailure(body, status, "Facebook did not return a long-lived token.");
  return { accessToken: token, expiresAt: expiresAt(body, 60 * 24 * 60 * 60) };
}

async function listFacebookPages(accessToken: string): Promise<FacebookPageChoice[]> {
  const pages: FacebookPageChoice[] = [];
  let after: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const params: Record<string, string> = {
      fields: "id,name,access_token",
      limit: "50",
    };
    if (after) params.after = after;
    const body = await graphGet(FACEBOOK_GRAPH, "me/accounts", accessToken, params);
    if (!isRecord(body) || !Array.isArray(body.data)) break;
    for (const entry of body.data) {
      if (!isRecord(entry)) continue;
      const id = readString(entry, "id");
      const token = readString(entry, "access_token");
      if (!id || !token) continue;
      pages.push({ id, name: readString(entry, "name") ?? id, accessToken: token });
    }
    after = nextCursor(body);
    if (!after) break;
  }
  if (pages.length === 0) {
    throw new PlatformApiError(
      "permission_denied",
      "Facebook did not return a Page for this login.",
      "Sign in with an account that can analyze a Page.",
    );
  }
  return pages;
}

function tokenUrl(params: Record<string, string>): string {
  const url = new URL(`${FACEBOOK_GRAPH}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function readAccessToken(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const direct = readString(body, "access_token");
  if (direct) return direct;
  const data = body.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return isRecord(first) ? readString(first, "access_token") : null;
  }
  return isRecord(data) ? readString(data, "access_token") : null;
}

function expiresAt(body: unknown, fallbackSeconds: number): string {
  const seconds = isRecord(body) ? asNumber(body.expires_in) : null;
  return new Date(Date.now() + (seconds ?? fallbackSeconds) * 1000).toISOString();
}

function nextCursor(body: Record<string, unknown>): string | null {
  const paging = body.paging;
  if (!isRecord(paging) || typeof paging.next !== "string" || !isRecord(paging.cursors)) return null;
  return readString(paging.cursors, "after");
}

function stripCode(code: string): string {
  return code.replace(/#_$/, "");
}

function metaFailure(body: unknown, status: number, fallback: string): PlatformApiError {
  if (isRecord(body) && isRecord(body.error)) return mapMetaError(body, status || 400);
  const message =
    isRecord(body) && typeof body.error_message === "string" ? body.error_message : fallback;
  return new PlatformApiError("token_invalid", sanitize(message), "Sign in again.", status || 400);
}

function sanitize(message: string): string {
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/client_secret=[^&\s]+/gi, "client_secret=[redacted]")
    .slice(0, 240);
}
