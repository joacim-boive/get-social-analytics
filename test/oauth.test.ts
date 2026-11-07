import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCredentials } from "../src/credentials.js";
import {
  exchangeFacebookCode,
  facebookAuthorizeUrl,
} from "../src/platforms/facebook.js";
import {
  exchangeInstagramCode,
  instagramAuthorizeUrl,
} from "../src/platforms/instagram.js";
import { createSettingsApp } from "../src/settings/routes.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_FACEBOOK_APP_ID;
  delete process.env.META_FACEBOOK_APP_SECRET;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("platform sign-in", () => {
  it("keeps a legacy Instagram or Facebook row readable", () => {
    expect(
      parseCredentials("instagram", {
        accessToken: "igaatoken",
        appSecret: "secret",
      }),
    ).toEqual({
      appId: null,
      appSecret: "secret",
      accessToken: "igaatoken",
    });
    expect(
      parseCredentials("facebook", {
        pageAccessToken: "page-token",
        pageId: "12",
      }),
    ).toEqual({
      appId: null,
      appSecret: null,
      pageAccessToken: "page-token",
      pageId: "12",
      pendingPages: null,
    });
  });

  it("builds Meta authorize URLs without a PKCE challenge", () => {
    const instagram = new URL(
      instagramAuthorizeUrl({
        appId: "ig-app",
        redirectUri: "http://127.0.0.1:8787/oauth/instagram/callback",
        state: "state-1",
      }),
    );
    expect(instagram.origin).toBe("https://www.instagram.com");
    expect(instagram.pathname).toBe("/oauth/authorize");
    expect(instagram.searchParams.get("client_id")).toBe("ig-app");
    expect(instagram.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_insights",
    );
    expect(instagram.searchParams.has("code_challenge")).toBe(false);
    expect(instagram.searchParams.has("enable_fb_login")).toBe(false);

    const facebook = new URL(
      facebookAuthorizeUrl({
        appId: "fb-app",
        redirectUri: "http://127.0.0.1:8787/oauth/facebook/callback",
        state: "state-2",
      }),
    );
    expect(facebook.origin).toBe("https://www.facebook.com");
    expect(facebook.pathname).toBe("/v26.0/dialog/oauth");
    expect(facebook.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,read_insights",
    );
    expect(facebook.searchParams.has("code_challenge")).toBe(false);
  });

  it("sends Instagram and YouTube sign-in to the provider after the app credentials are saved", async () => {
    const { app, store } = tempApp();
    process.env.META_APP_ID = "ig-app";
    process.env.META_APP_SECRET = "ig-secret";
    const instagramStart = await app.request(
      "http://127.0.0.1:8787/oauth/instagram/start",
    );
    const instagramLocation = new URL(
      instagramStart.headers.get("location") ?? "",
    );
    expect(instagramStart.status).toBe(302);
    expect(instagramLocation.origin).toBe("https://www.instagram.com");
    expect(instagramLocation.searchParams.has("code_challenge")).toBe(false);

    const youtubeSave = await app.request(
      "http://127.0.0.1:8787/api/connections/youtube",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "yt-client",
          clientSecret: "yt-secret",
          refreshToken: "",
        }),
      },
    );
    expect(youtubeSave.status).toBe(200);
    const youtubeStart = await app.request(
      "http://127.0.0.1:8787/oauth/youtube/start",
    );
    const youtubeLocation = new URL(youtubeStart.headers.get("location") ?? "");
    expect(youtubeLocation.origin).toBe("https://accounts.google.com");
    expect(youtubeLocation.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    store.close();
  });

  it("stores the long-lived Instagram token from the callback", async () => {
    const { app, store } = tempApp();
    process.env.META_APP_ID = "ig-app";
    process.env.META_APP_SECRET = "ig-secret";
    const start = await app.request(
      "http://127.0.0.1:8787/oauth/instagram/start",
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.instagram.com/oauth/access_token")) {
          return jsonResponse({ access_token: "short-token", user_id: "42" });
        }
        if (url.startsWith("https://graph.instagram.com/access_token")) {
          expect(url).toContain("grant_type=ig_exchange_token");
          return jsonResponse({
            access_token: "long-lived-token",
            expires_in: 5_184_000,
          });
        }
        if (url.includes("/me?")) {
          return jsonResponse({
            user_id: "42",
            username: "studio",
            name: "Studio",
            followers_count: 10,
          });
        }
        return jsonResponse({ error: { message: "unmocked", code: 1 } });
      }),
    );
    const callback = await app.request(
      `http://127.0.0.1:8787/oauth/instagram/callback?code=auth-code&state=${state ?? ""}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?connected=instagram");
    expect(store.get("instagram")?.credentials.accessToken).toBe(
      "long-lived-token",
    );
    expect(store.get("instagram")?.credentials.appSecret).toBeNull();
    expect(store.get("instagram")?.account?.handle).toBe("studio");
    store.close();
  });

  it("stores the matching Facebook Page and asks for a Page id when several match", async () => {
    const pages = [
      { id: "111", name: "First", access_token: "page-111" },
      { id: "222", name: "Second", access_token: "page-222" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/oauth/access_token") && url.includes("code=")) {
          return jsonResponse({ access_token: "user-short" });
        }
        if (url.includes("grant_type=fb_exchange_token")) {
          return jsonResponse({ access_token: "user-long" });
        }
        if (url.includes("/me/accounts")) return jsonResponse({ data: pages });
        if (url.includes("/222"))
          return jsonResponse({
            id: "222",
            name: "Second",
            username: "second",
          });
        throw new Error(url);
      }),
    );

    const choice = await exchangeFacebookCode({
      appId: "fb-app",
      appSecret: "fb-secret",
      code: "auth-code",
      redirectUri: "http://127.0.0.1:8787/oauth/facebook/callback",
      pageId: null,
    });
    expect(choice).toEqual({
      status: "choose",
      pages: [
        { id: "111", name: "First", accessToken: "page-111" },
        { id: "222", name: "Second", accessToken: "page-222" },
      ],
    });

    const matched = await exchangeFacebookCode({
      appId: "fb-app",
      appSecret: "fb-secret",
      code: "auth-code",
      redirectUri: "http://127.0.0.1:8787/oauth/facebook/callback",
      pageId: "222",
    });
    expect(matched).toEqual({
      status: "connected",
      pageAccessToken: "page-222",
      pageId: "222",
      pageName: "Second",
    });
  });

  it("exchanges an Instagram code for a long-lived token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.instagram.com/oauth/access_token")) {
          expect(String(init?.body)).toContain("code=auth-code");
          return jsonResponse({ data: [{ access_token: "short-token" }] });
        }
        if (url.startsWith("https://graph.instagram.com/access_token")) {
          return jsonResponse({
            access_token: "long-lived-token",
            expires_in: 60,
          });
        }
        throw new Error(url);
      }),
    );
    const exchanged = await exchangeInstagramCode({
      appId: "ig-app",
      appSecret: "ig-secret",
      code: "auth-code#_",
      redirectUri: "http://127.0.0.1:8787/oauth/instagram/callback",
    });
    expect(exchanged.accessToken).toBe("long-lived-token");
    expect(Date.parse(exchanged.expiresAt)).toBeGreaterThan(Date.now());
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
