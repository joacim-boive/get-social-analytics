import { describe, expect, it } from "vitest";
import { metaInsightDate } from "../src/platforms/insights.js";
import { toComparison } from "../src/report/compare.js";
import { resolvePeriod } from "../src/report/period.js";
import type { AnalyticsReport } from "../src/report/types.js";

const requested = resolvePeriod(
  { preset: "last_7_days" },
  new Date(2026, 9, 12),
);

describe("comparison JSON", () => {
  it("keeps an Instagram follower total out of follows gained and does not fill missing days", () => {
    const report = toComparison(fixture(), requested);
    const instagram = report.platforms.instagram;
    expect(instagram?.summary.followersSnapshot).toMatchObject({
      value: 120,
      scope: "snapshot",
      sourceMetric: "followers_count",
    });
    expect(instagram?.summary.followersGained.value).toBeNull();
    expect(instagram?.daily.map((row) => row.date)).toEqual([
      "2026-10-11",
      "2026-10-13",
    ]);
    expect(instagram?.daily[0]?.audienceTotal).toMatchObject({
      value: 118,
      scope: "snapshot",
      sourceMetric: "follower_count",
    });
    expect(instagram?.daily[0]?.followersGained).toBeNull();
    expect(instagram?.appliedPeriod?.startDate).toBe("2026-10-06");
    expect(instagram?.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(instagram?.dataThrough).toBeNull();
    expect(instagram?.contentRanking).toMatchObject({
      metric: "views",
      scope: "lifetime",
    });
    expect(instagram?.content[0]?.rankMetric).toBe("views");
    expect(instagram?.content[0]?.rankValue).toBe(40);
    expect(instagram?.content[0]?.publishedWithinPeriod).toBe(true);
    expect(instagram?.content[0]?.metrics.views).toMatchObject({
      scope: "lifetime",
      sourceMetric: "views",
    });
    expect(instagram?.content[0]?.metrics.impressions).toBeNull();
    expect(instagram?.content[0]?.retention).toBeNull();
  });

  it("marks YouTube partial when daily rows stop before the requested end and does not invent the missing days", () => {
    const report = toComparison(fixture(), requested);
    const youtube = report.platforms.youtube;
    expect(youtube?.status).toBe("partial");
    expect(youtube?.dataThrough).toBe("2026-10-10");
    expect(youtube?.daily.map((row) => row.date)).toEqual(["2026-10-10"]);
    expect(youtube?.account).toMatchObject({
      channelId: "UC123",
      title: "Channel",
      handle: "channel",
      subscriberCount: 50,
    });
    expect(youtube?.summary.subscribersSnapshot).toMatchObject({
      value: 50,
      scope: "snapshot",
    });
    expect(youtube?.summary.followersSnapshot.value).toBeNull();
    expect(youtube?.summary.netFollowerChange).toMatchObject({
      value: 2,
      scope: "derived",
    });
    expect(youtube?.summary.completionRate.value).toBeNull();
    expect(youtube?.contentRanking).toMatchObject({
      metric: "views",
      scope: "period",
    });
    expect(youtube?.content[0]?.rankValue).toBe(9);
    expect(youtube?.content[0]?.metrics.views).toMatchObject({
      value: 9,
      scope: "period",
    });
    expect(youtube?.content[0]?.publishedWithinPeriod).toBe(false);
  });

  it("keeps a platform error beside a successful platform", () => {
    const report = toComparison(fixture(), requested);
    expect(report.platforms.facebook?.status).toBe("error");
    expect(report.platforms.instagram?.status).not.toBe("error");
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});

describe("Meta insight dates", () => {
  it("labels an exclusive Pacific midnight as the measured Pacific day", () => {
    expect(metaInsightDate("2026-09-16T07:00:00+0000")).toBe("2026-09-15");
    expect(metaInsightDate("2026-10-13T07:00:00+0000")).toBe("2026-10-12");
  });
});

function fixture(): AnalyticsReport {
  return {
    generatedAt: "2026-10-12T12:00:00.000Z",
    platforms: [
      {
        platform: "instagram",
        status: "ok",
        account: { id: "ig-1", name: "Ada", handle: "ada" },
        period: {
          requested: { preset: "last_7_days" },
          applied: { start: "2026-10-06", end: "2026-10-12" },
          notes: [
            "Instagram media metrics are lifetime totals for items published in the range, not activity during the range.",
          ],
        },
        summary: [
          {
            key: "followers",
            label: "Followers",
            value: 120,
            unit: "accounts",
            aggregation: "snapshot",
            source: "followers_count",
          },
          {
            key: "views",
            label: "Views",
            value: 40,
            unit: "views",
            aggregation: "period_total",
            source: "views",
          },
          {
            key: "reach",
            label: "Reach",
            value: 30,
            unit: "accounts",
            aggregation: "period_total",
            source: "reach",
          },
          {
            key: "engagements",
            label: "Engagements",
            value: 5,
            unit: "interactions",
            aggregation: "period_total",
            source: "total_interactions",
          },
        ],
        series: [
          { date: "2026-10-11", metrics: { followers: 118 } },
          { date: "2026-10-13", metrics: { followers: 130 } },
        ],
        content: [
          {
            id: "media-1",
            kind: "reel",
            title: "Hello",
            url: "https://www.instagram.com/p/1",
            publishedAt: "2026-10-08T12:00:00.000Z",
            metricWindow: "lifetime",
            metrics: [
              {
                key: "views",
                label: "Views",
                value: 40,
                unit: "views",
                aggregation: "content_lifetime_sum",
                source: "views",
              },
            ],
          },
        ],
        unavailable: [
          {
            key: "watch_time_minutes",
            reason: "Instagram does not provide watch time.",
          },
        ],
      },
      {
        platform: "facebook",
        status: "error",
        period: {
          requested: { preset: "last_7_days" },
          applied: { start: "2026-10-06", end: "2026-10-12" },
          notes: [],
        },
        error: {
          code: "token_invalid",
          message: "The Page token was rejected.",
          action: "Paste a new token.",
        },
      },
      {
        platform: "youtube",
        status: "ok",
        account: { id: "UC123", name: "Channel", handle: "channel" },
        period: {
          requested: { preset: "last_7_days" },
          applied: { start: "2026-10-06", end: "2026-10-12" },
          notes: [],
        },
        summary: [
          {
            key: "followers",
            label: "Subscribers",
            value: 50,
            unit: "accounts",
            aggregation: "snapshot",
            source: "statistics.subscriberCount",
          },
          {
            key: "views",
            label: "Views",
            value: 9,
            unit: "views",
            aggregation: "period_total",
            source: "views",
          },
          {
            key: "followers_gained",
            label: "Subscribers gained",
            value: 3,
            unit: "accounts",
            aggregation: "period_total",
            source: "subscribersGained",
          },
          {
            key: "followers_lost",
            label: "Subscribers lost",
            value: 1,
            unit: "accounts",
            aggregation: "period_total",
            source: "subscribersLost",
          },
        ],
        series: [
          {
            date: "2026-10-10",
            metrics: { views: 9, followers_gained: 3, followers_lost: 1 },
          },
        ],
        content: [
          {
            id: "video-1",
            kind: "video",
            title: "Older video",
            url: "https://www.youtube.com/watch?v=video-1",
            publishedAt: "2026-01-02T00:00:00.000Z",
            metricWindow: "period",
            metrics: [
              {
                key: "views",
                label: "Views",
                value: 9,
                unit: "views",
                aggregation: "period_total",
                source: "views",
              },
            ],
          },
        ],
        unavailable: [
          {
            key: "reach",
            reason:
              "YouTube Analytics does not provide an account reach metric comparable to Instagram or Facebook.",
          },
        ],
      },
    ],
  };
}
