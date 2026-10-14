import type { CredentialStore } from "../store.js";
import type { PlatformId } from "../report/types.js";
import { isRecord, readString } from "../util.js";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function saveConnection(store: CredentialStore, platform: PlatformId, body: unknown): void {
  if (!isRecord(body)) throw new SettingsError("The form was empty.");
  if (platform === "instagram") {
    saveInstagram(store, body);
    return;
  }
  if (platform === "facebook") {
    saveFacebook(store, body);
    return;
  }
  if (platform === "tiktok") {
    saveTikTok(store, body);
    return;
  }
  throw new SettingsError("Sign in to connect YouTube.");
}

function saveInstagram(store: CredentialStore, body: Record<string, unknown>): void {
  const existing = store.get("instagram");
  const accessToken = secretField(body, "accessToken", existing?.credentials.accessToken ?? null, "Access token");
  const appSecret = secretField(body, "appSecret", existing?.credentials.appSecret ?? null, "App secret");
  store.save(
    "instagram",
    { accessToken: accessToken.value, appSecret: appSecret.value },
    accessToken.replaced ? { tokenExpiresAt: null } : {},
  );
}

function saveFacebook(store: CredentialStore, body: Record<string, unknown>): void {
  const existing = store.get("facebook");
  const pageAccessToken = secretField(body, "pageAccessToken", existing?.credentials.pageAccessToken ?? null, "Page access token");
  const pageId = "pageId" in body ? blankToNull(body.pageId) : (existing?.credentials.pageId ?? null);
  store.save("facebook", { pageAccessToken: pageAccessToken.value, pageId }, pageAccessToken.replaced ? { tokenExpiresAt: null } : {});
}

function saveTikTok(store: CredentialStore, body: Record<string, unknown>): void {
  const existing = store.get("tiktok");
  const clientKey = publicField(body, "clientKey", existing?.credentials.clientKey ?? null, "Client key");
  const clientSecret = secretField(body, "clientSecret", existing?.credentials.clientSecret ?? null, "Client secret");
  const accessToken = secretField(body, "accessToken", existing?.credentials.accessToken ?? null, "Access token");
  const refreshToken = secretField(body, "refreshToken", existing?.credentials.refreshToken ?? null, "Refresh token");
  const replaced = accessToken.replaced || refreshToken.replaced;
  store.save(
    "tiktok",
    {
      clientKey: clientKey.value,
      clientSecret: clientSecret.value,
      accessToken: accessToken.value,
      refreshToken: refreshToken.value,
      openId: existing?.credentials.openId ?? null,
    },
    replaced ? { tokenExpiresAt: null } : {},
  );
}

function secretField(
  body: Record<string, unknown>,
  key: string,
  existing: string | null,
  label: string,
): { value: string; replaced: boolean } {
  const incoming = readString(body, key);
  if (!incoming || incoming.startsWith("••••")) {
    if (!existing) throw new SettingsError(`${label} is required.`);
    return { value: existing, replaced: false };
  }
  return { value: incoming, replaced: true };
}

function publicField(
  body: Record<string, unknown>,
  key: string,
  existing: string | null,
  label: string,
): { value: string; replaced: boolean } {
  const incoming = readString(body, key);
  if (!incoming) {
    if (!existing) throw new SettingsError(`${label} is required.`);
    return { value: existing, replaced: false };
  }
  return { value: incoming, replaced: incoming !== existing };
}

function blankToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
