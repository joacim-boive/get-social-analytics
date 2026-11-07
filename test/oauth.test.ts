import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsApp } from "../src/settings/routes.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("application sign-in", () => {
  it("sends YouTube sign-in to Google with the server application id", async () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "yt-client.apps.googleusercontent.com");
    vi.stubEnv("YOUTUBE_CLIENT_SECRET", "yt-secret");
    const { app, store } = tempApp();
    const response = await app.request("http://127.0.0.1:8787/oauth/youtube/start");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("yt-client.apps.googleusercontent.com");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/oauth/youtube/callback",
    );
    expect(location.search).not.toContain("yt-secret");
    store.close();
  });

  it("asks for a saved YouTube client when the server application is not configured", async () => {
    const { app, store } = tempApp();
    const response = await app.request("http://127.0.0.1:8787/oauth/youtube/start");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "/", "http://127.0.0.1:8787");
    expect(location.searchParams.get("message")).toBe("Save the client id and secret first.");
    store.close();
  });

  it("stores the Instagram grant and uses it for the account lookup", async () => {
    vi.stubEnv("META_APP_ID", "meta-app");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://api.instagram.com/oauth/access_token")) {
        return json({ data: [{ access_token: "short-instagram-token", user_id: "1789" }] });
      }
      if (url.startsWith("https://graph.instagram.com/access_token")) {
        return json({ access_token: "long-instagram-token", expires_in: 5_184_000 });
      }
      if (url.includes("/me?")) {
        return json({ user_id: "1789", username: "ada", name: "Ada Lovelace", followers_count: 120 });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const { app, store } = tempApp();
    const start = await app.request("http://127.0.0.1:8787/oauth/instagram/start");
    const authorize = new URL(start.headers.get("location") ?? "");
    expect(authorize.origin).toBe("https://www.instagram.com");
    expect(authorize.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_insights",
    );
    const state = authorize.searchParams.get("state");
    const callback = await app.request(
      `http://127.0.0.1:8787/oauth/instagram/callback?state=${state}&code=auth-code`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?connected=instagram");
    expect(callback.headers.get("location")).not.toContain("long-instagram-token");
    const saved = store.get("instagram");
    expect(saved?.credentials.accessToken).toBe("long-instagram-token");
    expect(saved?.credentials.appSecret).toBe("meta-secret");
    expect(saved?.account).toMatchObject({ id: "1789", name: "Ada Lovelace", handle: "ada" });
    expect(seen.some((url) => url.includes("access_token=long-instagram-token"))).toBe(true);
    expect(seen.join("\n")).not.toContain("short-instagram-token&");
    store.close();
  });

  it("keeps a Facebook page choice on the server and stores only the selected page", async () => {
    vi.stubEnv("META_APP_ID", "meta-app");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/access_token") && url.includes("code=")) {
        return json({ access_token: "short-user-token", expires_in: 3600 });
      }
      if (url.includes("/oauth/access_token") && url.includes("fb_exchange_token=")) {
        return json({ access_token: "long-user-token", expires_in: 5_184_000 });
      }
      if (url.includes("/me/accounts")) {
        return json({
          data: [
            { id: "page-1", name: "News", access_token: "page-token-news" },
            { id: "page-2", name: "Shop", access_token: "page-token-shop" },
          ],
        });
      }
      if (url.includes("/page-2?")) {
        return json({ id: "page-2", name: "Shop", username: "shop", followers_count: 40 });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const { app, store } = tempApp();
    const start = await app.request("http://127.0.0.1:8787/oauth/facebook/start");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await app.request(
      `http://127.0.0.1:8787/oauth/facebook/callback?state=${state}&code=auth-code`,
    );
    const choice = new URL(callback.headers.get("location") ?? "", "http://127.0.0.1:8787");
    expect(choice.searchParams.get("choose")).toBe("facebook");
    expect(callback.headers.get("location")).not.toContain("page-token");
    const page = await app.request(`http://127.0.0.1:8787${choice.pathname}${choice.search}`);
    const html = await page.text();
    expect(html).toContain("Shop");
    expect(html).toContain("News");
    expect(html).not.toContain("page-token-shop");
    expect(html).not.toContain("long-user-token");
    const chooseState = choice.searchParams.get("state") ?? "";
    const chosen = await app.request("http://127.0.0.1:8787/oauth/facebook/choose", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: chooseState, pageId: "page-2" }),
    });
    expect(chosen.headers.get("location")).toBe("/?connected=facebook");
    expect(store.get("facebook")?.credentials).toEqual({
      pageAccessToken: "page-token-shop",
      pageId: "page-2",
    });
    store.close();
  });

  it("shows Sign in instead of token fields when the Meta application is configured", async () => {
    vi.stubEnv("META_APP_ID", "meta-app");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    const { app, store } = tempApp();
    const response = await app.request("http://127.0.0.1:8787/");
    const html = await response.text();
    expect(html).toContain('href="/oauth/instagram/start"');
    expect(html).toContain('href="/oauth/facebook/start"');
    expect(html).not.toContain('id="instagram-accessToken"');
    expect(html).not.toContain('id="facebook-pageAccessToken"');
    expect(html).toContain('name="clientKey"');
    store.close();
  });
});

function tempApp(): { app: ReturnType<typeof createSettingsApp>; store: CredentialStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  const store = openStore(path.join(directory, "analytics.sqlite"));
  return { app: createSettingsApp(store), store };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
