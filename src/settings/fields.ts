import type { PlatformId } from "../report/types.js";

export type FieldSpec = {
  name: string;
  label: string;
  secret: boolean;
  emptyHint?: string;
};

export const PLATFORM_FIELDS: Record<PlatformId, FieldSpec[]> = {
  instagram: [
    { name: "accessToken", label: "Access token", secret: true },
    { name: "appSecret", label: "App secret", secret: true },
  ],
  facebook: [
    { name: "pageAccessToken", label: "Page access token", secret: true },
    { name: "pageId", label: "Page id", secret: false },
  ],
  tiktok: [
    { name: "clientKey", label: "Client key", secret: false },
    { name: "clientSecret", label: "Client secret", secret: true },
    { name: "accessToken", label: "Access token", secret: true },
    { name: "refreshToken", label: "Refresh token", secret: true },
  ],
  youtube: [],
};
