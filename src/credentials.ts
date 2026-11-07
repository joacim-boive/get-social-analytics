import type { AccountProfile, PlatformId } from "./report/types.js";
import { isRecord, readString } from "./util.js";

export type InstagramCredentials = {
  appId: string | null;
  appSecret: string | null;
  accessToken: string | null;
};

export type FacebookPageChoice = {
  id: string;
  name: string;
  accessToken: string;
};

export type FacebookCredentials = {
  appId: string | null;
  appSecret: string | null;
  pageAccessToken: string | null;
  pageId: string | null;
  pendingPages: FacebookPageChoice[] | null;
};

export type TikTokCredentials = {
  clientKey: string;
  clientSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  openId: string | null;
};

export type YouTubeCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
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

export function parseCredentials<K extends PlatformId>(
  platform: K,
  value: unknown,
): CredentialMap[K] {
  if (platform === "instagram")
    return parseInstagram(value) as CredentialMap[K];
  if (platform === "facebook") return parseFacebook(value) as CredentialMap[K];
  if (platform === "tiktok") return parseTikTok(value) as CredentialMap[K];
  return parseYouTube(value) as CredentialMap[K];
}

function parseInstagram(value: unknown): InstagramCredentials {
  const record = expectRecord(value, "Instagram");
  const appId = readString(record, "appId");
  const appSecret = readString(record, "appSecret");
  const accessToken = readString(record, "accessToken");
  if (!accessToken && !(appId && appSecret)) {
    throw new Error("Instagram credentials are incomplete.");
  }
  return { appId, appSecret, accessToken };
}

function parseFacebook(value: unknown): FacebookCredentials {
  const record = expectRecord(value, "Facebook");
  const appId = readString(record, "appId");
  const appSecret = readString(record, "appSecret");
  const pageAccessToken = readString(record, "pageAccessToken");
  const pageId = readString(record, "pageId");
  const pendingPages = parsePendingPages(record.pendingPages);
  if (!pageAccessToken && !pendingPages && (!appId || !appSecret)) {
    throw new Error("Facebook credentials are incomplete.");
  }
  return { appId, appSecret, pageAccessToken, pageId, pendingPages };
}

function parsePendingPages(value: unknown): FacebookPageChoice[] | null {
  if (!Array.isArray(value)) return null;
  const pages = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.access_token !== "string" && typeof entry.accessToken !== "string") {
      return [];
    }
    const accessToken = typeof entry.accessToken === "string" ? entry.accessToken : entry.access_token;
    if (typeof accessToken !== "string") return [];
    const name = typeof entry.name === "string" ? entry.name : entry.id;
    return [{ id: entry.id, name, accessToken }];
  });
  return pages.length > 0 ? pages : null;
}

function parseTikTok(value: unknown): TikTokCredentials {
  const record = expectRecord(value, "TikTok");
  const clientKey = readString(record, "clientKey");
  const clientSecret = readString(record, "clientSecret");
  const accessToken = readString(record, "accessToken");
  const refreshToken = readString(record, "refreshToken");
  if (!clientKey || !clientSecret) {
    throw new Error("TikTok credentials are incomplete.");
  }
  return {
    clientKey,
    clientSecret,
    accessToken,
    refreshToken,
    openId: readString(record, "openId"),
  };
}

function parseYouTube(value: unknown): YouTubeCredentials {
  const record = expectRecord(value, "YouTube");
  const clientId = readString(record, "clientId");
  const clientSecret = readString(record, "clientSecret");
  if (!clientId || !clientSecret)
    throw new Error("YouTube credentials are incomplete.");
  return {
    clientId,
    clientSecret,
    refreshToken: readString(record, "refreshToken"),
    accessToken: readString(record, "accessToken"),
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} credentials are unreadable.`);
  return value;
}
