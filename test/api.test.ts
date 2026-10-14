import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsApp } from "../src/settings/routes.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("analytics HTTP API", () => {
  it("returns one not-configured platform without calling the social APIs", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("live API");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1/api/analytics/youtube?period=yesterday",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.platforms.youtube).toMatchObject({
      status: "unavailable",
      error: expect.objectContaining({ code: "not_configured" }),
    });
    expect(body.period).toMatchObject({
      key: "yesterday",
      days: 1,
      startInclusive: true,
      endInclusive: true,
    });
    expect(body.timezone).toEqual(expect.any(String));
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("keeps a platform failure inside a multi-platform report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("live API");
      }),
    );
    process.env.YOUTUBE_CLIENT_ID = "client-id.apps.googleusercontent.com";
    process.env.YOUTUBE_CLIENT_SECRET = "secret-value";
    const { app, store } = tempApp();
    store.save("youtube", {
      refreshToken: "refresh-value",
      accessToken: null,
    });
    const response = await app.request(
      "http://127.0.0.1/api/analytics?platforms=instagram,youtube&include=summary",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect([
      body.platforms.instagram.status,
      body.platforms.youtube.status,
    ]).toEqual(["unavailable", "error"]);
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("refresh-value");
    store.close();
  });

  it("serves content for one platform as markdown", async () => {
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1/api/content/tiktok?format=markdown&contentLimit=5",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const text = await response.text();
    expect(text).toContain("## TikTok");
    expect(text).toContain("Status: not_configured");
    store.close();
  });

  it("accepts the MCP-shaped JSON body", async () => {
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1/api/analytics/facebook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platforms: "youtube",
          period: { start: "2026-10-01", end: "2026-10-03" },
          include: "summary",
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.platforms)).toEqual(["facebook"]);
    expect(body.platforms.facebook).toMatchObject({
      status: "unavailable",
    });
    expect(body.period).toMatchObject({
      key: "custom",
      startDate: "2026-10-01",
      endDate: "2026-10-03",
      days: 3,
    });
    store.close();
  });

  it("accepts a day count as an inclusive range ending today", async () => {
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1/api/analytics/instagram?days=7&format=json",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const applied = body.period;
    expect(applied.days).toBe(7);
    expect(applied.endInclusive).toBe(true);
    store.close();
  });

  it("rejects a bad query and an unknown platform", async () => {
    const { app, store } = tempApp();
    const badRange = await app.request(
      "http://127.0.0.1/api/analytics?start=2026-10-08&end=2026-10-01",
    );
    expect(badRange.status).toBe(400);
    const unknown = await app.request("http://127.0.0.1/api/analytics/myspace");
    expect(unknown.status).toBe(404);
    const invalid = await app.request("http://127.0.0.1/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
    store.close();
  });

  it("lists platforms without secrets", async () => {
    const { app, store } = tempApp();
    store.save("youtube", {
      refreshToken: "refresh-secret-value",
      accessToken: null,
    });
    const response = await app.request("http://127.0.0.1/api/platforms");
    expect(response.status).toBe(200);
    const body = await response.json();
    const youtube = body.platforms.find(
      (platform: { platform: string }) => platform.platform === "youtube",
    );
    expect(youtube).toMatchObject({
      connected: true,
      accountName: null,
      tokenExpiresAt: null,
    });
    expect(JSON.stringify(body)).not.toContain("refresh-secret-value");
    store.close();
  });
});

function tempApp(): {
  app: ReturnType<typeof createSettingsApp>;
  store: CredentialStore;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  const store = openStore(path.join(directory, "analytics.sqlite"));
  return { app: createSettingsApp(store), store };
}
