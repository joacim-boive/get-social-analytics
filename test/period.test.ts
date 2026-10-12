import { describe, expect, it } from "vitest";
import {
  clampLookback,
  PeriodError,
  resolvePeriod,
} from "../src/report/period.js";

const now = new Date(2026, 9, 12);

describe("resolvePeriod", () => {
  it("resolves presets as inclusive local calendar days", () => {
    expect(resolvePeriod({ preset: "yesterday" }, now)).toMatchObject({
      start: "2026-10-11",
      end: "2026-10-11",
    });
    expect(resolvePeriod({ preset: "last_7_days" }, now)).toMatchObject({
      start: "2026-10-06",
      end: "2026-10-12",
    });
    expect(resolvePeriod({ preset: "last_28_days" }, now)).toMatchObject({
      start: "2026-09-15",
      end: "2026-10-12",
    });
    expect(resolvePeriod({ preset: "this_month" }, now)).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-12",
    });
    expect(resolvePeriod({ preset: "last_month" }, now)).toMatchObject({
      start: "2026-09-01",
      end: "2026-09-30",
    });
  });

  it("rejects an inverted custom range", () => {
    expect(() =>
      resolvePeriod({ start: "2026-10-12", end: "2026-10-01" }, now),
    ).toThrow(PeriodError);
  });
});

describe("clampLookback", () => {
  it("moves the start forward when the platform cannot look back that far", () => {
    const period = resolvePeriod(
      { start: "2026-01-01", end: "2026-10-12" },
      now,
    );
    const clamped = clampLookback(
      period,
      "2026-07-14",
      "Instagram only stores about 90 days.",
    );
    expect(clamped.start).toBe("2026-07-14");
    expect(clamped.end).toBe("2026-10-12");
    expect(clamped.notes[0]).toContain("90 days");
  });

  it("collapses a range that is entirely too old", () => {
    const period = resolvePeriod(
      { start: "2020-01-01", end: "2020-01-02" },
      now,
    );
    const clamped = clampLookback(
      period,
      "2026-07-14",
      "Instagram only stores about 90 days.",
    );
    expect(clamped).toMatchObject({ start: "2026-07-14", end: "2026-07-14" });
    expect(clamped.notes[0]).toContain("older");
  });
});
