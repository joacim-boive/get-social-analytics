import type { PlatformId } from "../report/types.js";

export type FieldSpec = {
  name: string;
  label: string;
  secret: boolean;
  emptyHint?: string;
};

export const PLATFORM_FIELDS: Record<PlatformId, FieldSpec[]> = {
  instagram: [],
  facebook: [],
  tiktok: [
    { name: "clientKey", label: "Client key", secret: false },
    { name: "clientSecret", label: "Client secret", secret: true },
    {
      name: "accessToken",
      label: "Access token",
      secret: true,
      emptyHint: "Leave blank, then sign in",
    },
    {
      name: "refreshToken",
      label: "Refresh token",
      secret: true,
      emptyHint: "Leave blank, then sign in",
    },
  ],
  youtube: [
    { name: "clientId", label: "Client id", secret: false },
    { name: "clientSecret", label: "Client secret", secret: true },
    {
      name: "refreshToken",
      label: "Refresh token",
      secret: true,
      emptyHint: "Leave blank, then sign in",
    },
  ],
};
