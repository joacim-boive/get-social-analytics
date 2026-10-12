import type { AccountProfile, PlatformId } from "./report/types.js";
import { isRecord, readString } from "./util.js";

export type InstagramCredentials = {
  accessToken: string;
  appSecret: string;
};

export type FacebookCredentials = {
  pageAccessToken: string;
  pageId: string | null;
};

export type TikTokCredentials = {
  clientKey: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  openId: string | null;
};

export type YouTubeCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string | null;
};

export type CredentialMap = {
  instagram: InstagramCredentials;
  facebook: FacebookCredentials;
  tiktok: TikTokCredentials;
  youtube: YouTubeCredentials;
};

export type StoredConnection<K extends PlatformId = PlatformId> = {
  platform: K;
  credentials: CredentialMap[K];
  account: AccountProfile | null;
  tokenExpiresAt: string | null;
  updatedAt: string;
};

export function parseCredentials<K extends PlatformId>(platform: K, value: unknown): CredentialMap[K] {
  if (platform === "instagram") return parseInstagram(value) as CredentialMap[K];
  if (platform === "facebook") return parseFacebook(value) as CredentialMap[K];
  if (platform === "tiktok") return parseTikTok(value) as CredentialMap[K];
  return parseYouTube(value) as CredentialMap[K];
}

function parseInstagram(value: unknown): InstagramCredentials {
  const record = expectRecord(value, "Instagram");
  const accessToken = readString(record, "accessToken");
  const appSecret = readString(record, "appSecret");
  if (!accessToken || !appSecret) throw new Error("Instagram credentials are incomplete.");
  return { accessToken, appSecret };
}

function parseFacebook(value: unknown): FacebookCredentials {
  const record = expectRecord(value, "Facebook");
  const pageAccessToken = readString(record, "pageAccessToken");
  if (!pageAccessToken) throw new Error("Facebook credentials are incomplete.");
  return { pageAccessToken, pageId: readString(record, "pageId") };
}

function parseTikTok(value: unknown): TikTokCredentials {
  const record = expectRecord(value, "TikTok");
  const clientKey = readString(record, "clientKey");
  const clientSecret = readString(record, "clientSecret");
  const accessToken = readString(record, "accessToken");
  const refreshToken = readString(record, "refreshToken");
  if (!clientKey || !clientSecret || !accessToken || !refreshToken) {
    throw new Error("TikTok credentials are incomplete.");
  }
  return { clientKey, clientSecret, accessToken, refreshToken, openId: readString(record, "openId") };
}

function parseYouTube(value: unknown): YouTubeCredentials {
  const record = expectRecord(value, "YouTube");
  const clientId = readString(record, "clientId");
  const clientSecret = readString(record, "clientSecret");
  const refreshToken = readString(record, "refreshToken");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("YouTube credentials are incomplete.");
  return { clientId, clientSecret, refreshToken, accessToken: readString(record, "accessToken") };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} credentials are unreadable.`);
  return value;
}
