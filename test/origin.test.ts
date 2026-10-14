import { afterEach, describe, expect, it } from "vitest";
import { clerkAccountPortal } from "../src/auth.js";
import {
  assertAllowedOrigin,
  isAllowedOrigin,
  requestOrigin,
} from "../src/settings/origin.js";
import { SettingsError } from "../src/settings/save.js";

afterEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
});

describe("hosted origins", () => {
  it("allows localhost and the production site", () => {
    process.env.APP_ORIGIN = "https://get-social-analytics.vercel.app";
    expect(isAllowedOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isAllowedOrigin("https://get-social-analytics.vercel.app")).toBe(
      true,
    );
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(() => assertAllowedOrigin("https://evil.example")).toThrow(
      SettingsError,
    );
  });

  it("uses the Clerk account portal for a development publishable key", () => {
    const key = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;
    expect(clerkAccountPortal(key)).toBe("https://example.accounts.dev");
  });

  it("reads the public host from forwarded headers", () => {
    const headers = new Headers({
      "x-forwarded-host": "get-social-analytics.vercel.app",
      "x-forwarded-proto": "https",
    });
    expect(requestOrigin("http://internal/oauth/youtube/start", headers)).toBe(
      "https://get-social-analytics.vercel.app",
    );
  });
});
