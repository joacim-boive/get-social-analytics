import type { CredentialMap } from "../credentials.js";
import type { AccountProfile, PlatformId } from "../report/types.js";
import { PLATFORM_IDS } from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { isRecord, readString } from "../util.js";
import { PLATFORM_FIELDS } from "./fields.js";

export type PublicField = {
  set: boolean;
  last4: string | null;
  publicValue: string | null;
};

export type PublicConnection = {
  platform: PlatformId;
  configured: boolean;
  account: AccountProfile | null;
  tokenExpiresAt: string | null;
  fields: Record<string, PublicField>;
  choices: { id: string; name: string }[];
};

export function listPublic(store: CredentialStore): PublicConnection[] {
  return PLATFORM_IDS.map((platform) => toPublic(store, platform));
}

export function toPublic(store: CredentialStore, platform: PlatformId): PublicConnection {
  const connection = store.get(platform);
  const fields: Record<string, PublicField> = {};
  for (const field of PLATFORM_FIELDS[platform]) {
    const value = connection ? credentialField(connection.credentials, field.name) : null;
    if (!field.secret) {
      fields[field.name] = { set: value !== null, last4: null, publicValue: value };
      continue;
    }
    fields[field.name] = {
      set: value !== null,
      last4: value ? value.slice(-4) : null,
      publicValue: null,
    };
  }
  return {
    platform,
    configured: connection !== null,
    account: connection?.account ?? null,
    tokenExpiresAt: connection?.tokenExpiresAt ?? null,
    fields,
    choices: pageChoices(connection?.credentials),
  };
}

function pageChoices(credentials: CredentialMap[PlatformId] | undefined): { id: string; name: string }[] {
  if (!credentials || !("pendingPages" in credentials) || !credentials.pendingPages) return [];
  return credentials.pendingPages.map((page) => ({ id: page.id, name: page.name }));
}

function credentialField(credentials: CredentialMap[PlatformId], name: string): string | null {
  if (!isRecord(credentials)) return null;
  return readString(credentials, name);
}
