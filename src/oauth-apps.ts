export type YouTubeApp = {
  clientId: string;
  clientSecret: string;
};

export function youtubeApp(): YouTubeApp | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function youtubeAppMessage(): string {
  return "YouTube sign-in is not configured on this server. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.";
}
