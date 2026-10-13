import { describe, expect, it } from "vitest";
import { parseInsightPayload } from "../src/platforms/insights.js";

describe("insight payload shapes", () => {
  it("reads Instagram media lifetime values and Facebook lifetime values without an end time", () => {
    const parsed = parseInsightPayload({
      data: [
        { name: "views", period: "lifetime", value: { value: 1249 } },
        { name: "ig_reels_avg_watch_time", period: "lifetime", value: { value: 9855 } },
        { name: "post_media_view", period: "lifetime", values: [{ value: 7848 }] },
        { name: "saved", period: "lifetime", value: { value: 0 } },
        {
          name: "page_media_view",
          period: "day",
          values: [{ value: 6616, end_time: "2026-09-16T07:00:00+0000" }],
        },
      ],
    });
    expect(parsed.find((item) => item.name === "views")?.totalValue).toBe(1249);
    expect(parsed.find((item) => item.name === "ig_reels_avg_watch_time")?.totalValue).toBe(9855);
    expect(parsed.find((item) => item.name === "post_media_view")?.totalValue).toBe(7848);
    expect(parsed.find((item) => item.name === "saved")?.totalValue).toBe(0);
    expect(parsed.find((item) => item.name === "page_media_view")?.points).toEqual([
      { date: "2026-09-15", value: 6616 },
    ]);
  });
});
