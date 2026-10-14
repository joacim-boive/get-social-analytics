import { userGrantReady } from "../credentials.js";
import type { CredentialStore } from "../store.js";
import type { AccountProfile, PlatformId } from "../report/types.js";
import { platformLabel } from "../report/types.js";
import { PlatformApiError } from "./errors.js";

export function rememberAccount<K extends PlatformId>(
  store: CredentialStore,
  platform: K,
  account: AccountProfile,
  tokenExpiresAt?: string | null,
): void {
  const current = store.get(platform);
  if (!current) return;
  if (tokenExpiresAt === undefined) {
    store.save(platform, current.credentials, { account });
    return;
  }
  store.save(platform, current.credentials, { account, tokenExpiresAt });
}

export function requireConnection<K extends PlatformId>(store: CredentialStore, platform: K) {
  const connection = store.get(platform);
  if (!connection || !userGrantReady(connection)) {
    throw new PlatformApiError(
      "not_configured",
      `${platformLabel(platform)} is not connected.`,
      platform === "youtube"
        ? "Sign in with YouTube on the settings page."
        : "Open the settings page and add credentials for this platform.",
    );
  }
  return connection;
}
