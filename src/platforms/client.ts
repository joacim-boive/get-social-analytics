import { userGrantReady } from "../credentials.js";
import {
  emptyReport,
  failureReport,
  notConfiguredReport,
} from "../report/build.js";
import { PeriodError, resolvePeriod } from "../report/period.js";
import type {
  AccountProfile,
  AnalyticsReport,
  IncludeMode,
  PeriodRequest,
  PlatformId,
  PlatformReport,
  ReportFormat,
  ResolvedPeriod,
} from "../report/types.js";
import { PLATFORM_IDS } from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { facebookClient } from "./facebook.js";
import { instagramClient } from "./instagram.js";
import { tiktokClient } from "./tiktok.js";
import { youtubeClient } from "./youtube.js";

export type AnalyticsQuery = {
  period: ResolvedPeriod;
  include: IncludeMode;
  contentLimit: number;
};

export type PlatformClient = {
  id: PlatformId;
  capabilities: string[];
  limitations: string[];
  test: (store: CredentialStore) => Promise<AccountProfile>;
  analytics: (
    store: CredentialStore,
    query: AnalyticsQuery,
  ) => Promise<PlatformReport>;
  content: (
    store: CredentialStore,
    query: AnalyticsQuery,
  ) => Promise<PlatformReport>;
};

const clients: Record<PlatformId, PlatformClient> = {
  instagram: instagramClient,
  facebook: facebookClient,
  tiktok: tiktokClient,
  youtube: youtubeClient,
};

export function getClient(platform: PlatformId): PlatformClient {
  return clients[platform];
}

export function platformCatalog(): Array<{
  platform: PlatformId;
  capabilities: string[];
  limitations: string[];
}> {
  return PLATFORM_IDS.map((platform) => ({
    platform,
    capabilities: clients[platform].capabilities,
    limitations: clients[platform].limitations,
  }));
}

export type PlatformStatus = {
  platform: PlatformId;
  connected: boolean;
  accountName: string | null;
  accountHandle: string | null;
  tokenExpiresAt: string | null;
  capabilities: string[];
  limitations: string[];
};

export function describePlatforms(store: CredentialStore): PlatformStatus[] {
  return platformCatalog().map((entry) => {
    const connection = store.get(entry.platform);
    return {
      platform: entry.platform,
      connected: connection !== null && userGrantReady(connection),
      accountName: connection?.account?.name ?? null,
      accountHandle: connection?.account?.handle ?? null,
      tokenExpiresAt: connection?.tokenExpiresAt ?? null,
      capabilities: entry.capabilities,
      limitations: entry.limitations,
    };
  });
}

export type AnalyticsArgs = {
  platforms?: PlatformId | PlatformId[] | "all";
  period?: PeriodRequest;
  format?: ReportFormat;
  include?: IncludeMode;
  contentLimit?: number;
};

export function normalizeQuery(args: AnalyticsArgs): {
  platforms: PlatformId[];
  query: AnalyticsQuery;
  format: ReportFormat;
} {
  const period = resolvePeriod(args.period ?? { preset: "last_7_days" });
  const include = args.include ?? "both";
  const contentLimit = args.contentLimit ?? 10;
  if (
    !Number.isInteger(contentLimit) ||
    contentLimit < 1 ||
    contentLimit > 50
  ) {
    throw new PeriodError("contentLimit must be a whole number from 1 to 50.");
  }
  const format = args.format ?? "json";
  return {
    platforms: selectedPlatforms(args.platforms),
    query: { period, include, contentLimit },
    format,
  };
}

function selectedPlatforms(value: AnalyticsArgs["platforms"]): PlatformId[] {
  if (!value || value === "all") return [...PLATFORM_IDS];
  const requested = Array.isArray(value) ? value : [value];
  if (requested.length === 0)
    throw new PeriodError("platforms must name at least one platform.");
  const seen = new Set<PlatformId>();
  const platforms: PlatformId[] = [];
  for (const platform of requested) {
    if (seen.has(platform)) continue;
    seen.add(platform);
    platforms.push(platform);
  }
  return platforms;
}

export async function collectReports(
  store: CredentialStore,
  platforms: PlatformId[],
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<AnalyticsReport> {
  const blocks = await Promise.all(
    platforms.map(async (platform) => collectOne(store, platform, query, mode)),
  );
  return emptyReport(blocks);
}

async function collectOne(
  store: CredentialStore,
  platform: PlatformId,
  query: AnalyticsQuery,
  mode: "analytics" | "content",
): Promise<PlatformReport> {
  try {
    const connection = store.get(platform);
    if (!connection || !userGrantReady(connection))
      return notConfiguredReport(platform, query.period);
    const client = clients[platform];
    return mode === "analytics"
      ? await client.analytics(store, query)
      : await client.content(store, query);
  } catch (error) {
    return failureReport(platform, query.period, error);
  }
}
