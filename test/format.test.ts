import { describe, expect, it } from "vitest";
import { formatReport } from "../src/report/format.js";
import type { AnalyticsReport } from "../src/report/types.js";

const report: AnalyticsReport = {
  generatedAt: "2026-10-12T12:00:00.000Z",
  platforms: [
    {
      platform: "tiktok",
      status: "ok",
      account: { id: "1", name: "Ada", handle: "ada" },
      period: {
        requested: { preset: "last_7_days" },
        applied: { start: "2026-10-01", end: "2026-10-02" },
        notes: ["TikTok counts are lifetime totals."],
      },
      summary: [
        {
          key: "views",
          label: "Views",
          value: 1200,
          unit: "views",
          aggregation: "content_lifetime_sum",
          source: "view_count",
        },
      ],
      series: [{ date: "2026-10-07", metrics: { views: 40 } }],
      content: [
        {
          id: "video-1",
          kind: "video",
          title: "Launch film",
          url: "https://www.tiktok.com/@ada/video/1",
          publishedAt: "2026-10-01T10:00:00.000Z",
          metricWindow: "lifetime",
          metrics: [],
        },
      ],
      unavailable: [
        { key: "reach", reason: "TikTok Display API does not provide reach." },
      ],
    },
    {
      platform: "youtube",
      status: "error",
      error: {
        code: "token_invalid",
        message: "The refresh token was rejected.",
        action: "Sign in again on the settings page.",
      },
    },
  ],
};

describe("formatReport", () => {
  it("keeps series and aggregation in JSON", () => {
    const json = formatReport(report, "json");
    expect(json).toContain('"series"');
    expect(json).toContain("2026-10-07");
    expect(json).toContain("content_lifetime_sum");
    expect(json).toContain("token_invalid");
  });

  it("omits daily series from markdown and keeps the action", () => {
    const markdown = formatReport(report, "markdown");
    expect(markdown).not.toContain("2026-10-07");
    expect(markdown).toContain("lifetime sum of items in range");
    expect(markdown).toContain("TikTok counts are lifetime totals.");
    expect(markdown).toContain("Sign in again on the settings page.");
    expect(markdown).toContain("Launch film");
    expect(markdown).not.toContain('"series"');
  });
});
