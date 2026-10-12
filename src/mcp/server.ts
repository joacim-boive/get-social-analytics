import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectReports, normalizeQuery, platformCatalog, type AnalyticsArgs } from "../platforms/client.js";
import { formatReport } from "../report/format.js";
import { PeriodError } from "../report/period.js";
import type { CredentialStore } from "../store.js";

const periodSchema = z.union([
  z.object({
    preset: z.enum(["yesterday", "last_7_days", "last_28_days", "last_90_days", "this_month", "last_month"]),
  }),
  z.object({
    start: z.string().describe("Inclusive start date, YYYY-MM-DD, in the server's local timezone."),
    end: z.string().describe("Inclusive end date, YYYY-MM-DD, in the server's local timezone."),
  }),
]);

const platformSchema = z
  .enum(["instagram", "facebook", "tiktok", "youtube", "all"])
  .describe("Which connected account to read. Defaults to all.");

export function createMcpServer(store: CredentialStore): McpServer {
  const server = new McpServer({ name: "social-analytics", version: "1.0.0" });

  server.registerTool(
    "list_platforms",
    {
      title: "List platforms",
      description:
        "Show which of Instagram, Facebook, TikTok, and YouTube have saved credentials, the connected account, token expiry, and what a later analytics call can and cannot answer. Does not call the social APIs and never returns secrets.",
      inputSchema: {},
    },
    async () => {
      const platforms = platformCatalog().map((entry) => {
        const connection = store.get(entry.platform);
        return {
          platform: entry.platform,
          connected: connection !== null,
          accountName: connection?.account?.name ?? null,
          accountHandle: connection?.account?.handle ?? null,
          tokenExpiresAt: connection?.tokenExpiresAt ?? null,
          capabilities: entry.capabilities,
          limitations: entry.limitations,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ platforms }, null, 2) }] };
    },
  );

  server.registerTool(
    "get_analytics",
    {
      title: "Get analytics",
      description: [
        "Fetch normalized analytics for the connected social accounts.",
        "Call this before a decision that depends on recent performance. Dates are calendar days in the timezone of the machine running the server.",
        "platforms: instagram, facebook, tiktok, youtube, or all (default all).",
        "period: { preset } or { start, end } as inclusive YYYY-MM-DD. Presets: yesterday, last_7_days, last_28_days, last_90_days, this_month, last_month. Default last_7_days, which includes today.",
        "format: json (default) or markdown. Markdown omits daily series.",
        "include: summary, content, or both (default both).",
        "contentLimit: 1-50, default 10.",
        "Read aggregation on every metric. period_total was measured during the applied range. snapshot is the current value, not a change. content_lifetime_sum adds lifetime totals of items published in the range; TikTok views work this way.",
        "Read unavailable and period.notes before treating a missing or zero value as a real result. One platform's error does not fail the others.",
      ].join(" "),
      inputSchema: {
        platforms: platformSchema.optional(),
        period: periodSchema.optional(),
        format: z.enum(["json", "markdown"]).optional(),
        include: z.enum(["summary", "content", "both"]).optional(),
        contentLimit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => runReport(store, args, "analytics"),
  );

  server.registerTool(
    "get_content",
    {
      title: "Get content",
      description: [
        "List posts or videos for the requested platforms and period, ranked by views then engagements.",
        "Same platforms, period, format, and contentLimit arguments as get_analytics.",
        "TikTok, Instagram, and Facebook item counts are lifetime totals. YouTube item counts are activity during the period and can include older videos.",
      ].join(" "),
      inputSchema: {
        platforms: platformSchema.optional(),
        period: periodSchema.optional(),
        format: z.enum(["json", "markdown"]).optional(),
        contentLimit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => runReport(store, { ...args, include: "content" }, "content"),
  );

  return server;
}

async function runReport(
  store: CredentialStore,
  args: AnalyticsArgs,
  mode: "analytics" | "content",
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
  try {
    const normalized = normalizeQuery(args);
    const report = await collectReports(store, normalized.platforms, normalized.query, mode);
    return { content: [{ type: "text", text: formatReport(report, normalized.format) }] };
  } catch (error) {
    const message = error instanceof PeriodError ? error.message : "The analytics request could not be built.";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
