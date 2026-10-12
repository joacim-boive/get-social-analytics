import { describe, expect, it } from "vitest";
import {
  mapGoogleError,
  mapMetaError,
  mapTikTokError,
} from "../src/platforms/errors.js";
import { failureReport } from "../src/report/build.js";
import { resolvePeriod } from "../src/report/period.js";

const period = resolvePeriod({ preset: "yesterday" }, new Date(2026, 9, 12));

describe("platform error mapping", () => {
  it("maps an expired Meta token to a settings action", () => {
    const error = mapMetaError(
      {
        error: {
          message: "Error validating access token",
          type: "OAuthException",
          code: 190,
        },
      },
      400,
    );
    expect(error.code).toBe("token_invalid");
    expect(error.action).toContain("settings page");
    const report = failureReport("instagram", period, error);
    expect(report.status).toBe("error");
    expect(report.error).toMatchObject({ code: "token_invalid" });
  });

  it("maps a Meta permission failure separately from a bad metric", () => {
    expect(
      mapMetaError({ error: { message: "Permission denied", code: 200 } }, 403)
        .code,
    ).toBe("permission_denied");
    expect(
      mapMetaError(
        { error: { message: "(#100) invalid metric", code: 100 } },
        400,
      ).code,
    ).toBe("invalid_metric");
  });

  it("maps TikTok refresh and scope failures", () => {
    const expired = mapTikTokError(
      {
        error: "invalid_grant",
        error_description: "Refresh token is invalid or expired.",
      },
      400,
    );
    expect(expired.code).toBe("token_invalid");
    expect(expired.action).toContain("Sign in again");
    const scope = mapTikTokError(
      {
        error: {
          code: "scope_not_authorized",
          message: "The user did not authorize the scope.",
        },
      },
      401,
    );
    expect(scope.code).toBe("permission_denied");
  });

  it("maps a revoked YouTube grant to a sign-in action", () => {
    const error = mapGoogleError(
      {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
      400,
    );
    expect(error.code).toBe("token_invalid");
    expect(error.action).toContain("Sign in");
    const quota = mapGoogleError(
      {
        error: {
          message: "Quota exceeded",
          errors: [{ reason: "quotaExceeded", message: "Quota exceeded" }],
        },
      },
      403,
    );
    expect(quota.code).toBe("rate_limited");
  });
});
