import type { PlatformId } from "../report/types.js";

export type MetaApp = {
  appId: string;
  appSecret: string;
};

export type TikTokApp = {
  clientKey: string;
  clientSecret: string;
};

export type YouTubeApp = {
  clientId: string;
  clientSecret: string;
};

export type ServerApps = {
  meta: MetaApp | null;
  tiktok: TikTokApp | null;
  youtube: YouTubeApp | null;
};

export function serverApps(
  env: Record<string, string | undefined> = process.env,
): ServerApps {
  const metaId = clean(env.META_APP_ID);
  const metaSecret = clean(env.META_APP_SECRET);
  const tiktokKey = clean(env.TIKTOK_CLIENT_KEY);
  const tiktokSecret = clean(env.TIKTOK_CLIENT_SECRET);
  const youtubeId = clean(env.YOUTUBE_CLIENT_ID);
  const youtubeSecret = clean(env.YOUTUBE_CLIENT_SECRET);
  return {
    meta: metaId && metaSecret ? { appId: metaId, appSecret: metaSecret } : null,
    tiktok:
      tiktokKey && tiktokSecret
        ? { clientKey: tiktokKey, clientSecret: tiktokSecret }
        : null,
    youtube:
      youtubeId && youtubeSecret
        ? { clientId: youtubeId, clientSecret: youtubeSecret }
        : null,
  };
}

export function loginReady(
  platform: PlatformId,
  apps: ServerApps = serverApps(),
): boolean {
  if (platform === "instagram" || platform === "facebook") return apps.meta !== null;
  if (platform === "tiktok") return apps.tiktok !== null;
  return apps.youtube !== null;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
