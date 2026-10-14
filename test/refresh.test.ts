import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshTikTokCredentials } from "../src/platforms/tiktok.js";
import { refreshYouTubeCredentials } from "../src/platforms/youtube.js";
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

describe("token refresh persistence", () => {
  it("stores TikTok's rotated refresh token", async () => {
    const store = tempStore();
    store.save(
      "tiktok",
      {
        clientKey: "key",
        clientSecret: "secret",
        accessToken: "act-old",
        refreshToken: "rft-old",
        openId: null,
      },
      { tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    );
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(String(input)).toContain("/v2/oauth/token/");
      return jsonResponse({
        access_token: "act-new",
        refresh_token: "rft-new",
        expires_in: 86400,
        open_id: "open-1",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await refreshTikTokCredentials(store);
    expect(saved.credentials.accessToken).toBe("act-new");
    expect(saved.credentials.refreshToken).toBe("rft-new");
    expect(saved.credentials.openId).toBe("open-1");
    expect(saved.tokenExpiresAt).not.toBeNull();
    expect(store.get("tiktok")?.credentials.refreshToken).toBe("rft-new");
    store.close();
  });

  it("keeps the YouTube refresh token when Google only returns a new access token", async () => {
    process.env.YOUTUBE_CLIENT_ID = "env-client";
    process.env.YOUTUBE_CLIENT_SECRET = "env-secret";
    const store = tempStore();
    store.save(
      "youtube",
      {
        refreshToken: "refresh-old",
        accessToken: "access-old",
      },
      { tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    );
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("client_id")).toBe("env-client");
      expect(params.get("client_secret")).toBe("env-secret");
      expect(params.get("refresh_token")).toBe("refresh-old");
      return jsonResponse({
        access_token: "access-new",
        expires_in: 3600,
        token_type: "Bearer",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await refreshYouTubeCredentials(store);
    expect(saved.credentials.accessToken).toBe("access-new");
    expect(saved.credentials.refreshToken).toBe("refresh-old");
    expect(store.get("youtube")?.credentials.accessToken).toBe("access-new");
    expect(JSON.stringify(saved.credentials)).not.toContain("env-secret");
    store.close();
  });
});

function tempStore(): CredentialStore {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  return openStore(path.join(directory, "analytics.sqlite"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
