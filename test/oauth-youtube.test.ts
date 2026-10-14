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

describe("YouTube sign-in", () => {
  it("tells the visitor when the server app is missing", async () => {
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1:8787/oauth/youtube/start",
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("error=youtube");
    expect(decodeURIComponent(location)).toContain("YOUTUBE_CLIENT_ID");
    store.close();
  });

  it("sends the visitor to Google with the server app", async () => {
    process.env.YOUTUBE_CLIENT_ID = "yt-client.apps.googleusercontent.com";
    process.env.YOUTUBE_CLIENT_SECRET = "yt-secret";
    const { app, store } = tempApp();
    const response = await app.request(
      "http://127.0.0.1:8787/oauth/youtube/start",
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe(
      "yt-client.apps.googleusercontent.com",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/oauth/youtube/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("access_type")).toBe("offline");
    store.close();
  });

  it("stores the channel refresh token and not the app secret", async () => {
    process.env.YOUTUBE_CLIENT_ID = "yt-client.apps.googleusercontent.com";
    process.env.YOUTUBE_CLIENT_SECRET = "yt-secret";
    const { app, store } = tempApp();
    const start = await app.request(
      "http://127.0.0.1:8787/oauth/youtube/start",
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          const params = new URLSearchParams(String(init?.body ?? ""));
          expect(params.get("client_id")).toBe(
            "yt-client.apps.googleusercontent.com",
          );
          expect(params.get("client_secret")).toBe("yt-secret");
          expect(params.get("code")).toBe("auth-code");
          return jsonResponse({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (url.includes("/youtube/v3/channels")) {
          return jsonResponse({
            items: [
              {
                id: "UC1",
                snippet: { title: "Channel", customUrl: "@channel" },
                statistics: { subscriberCount: "10" },
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }),
    );
    const callback = await app.request(
      `http://127.0.0.1:8787/oauth/youtube/callback?code=auth-code&state=${state}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("connected=youtube");
    const saved = store.get("youtube");
    expect(saved?.credentials).toEqual({
      refreshToken: "refresh-1",
      accessToken: "access-1",
    });
    expect(JSON.stringify(saved)).not.toContain("yt-secret");
    expect(saved?.account?.name).toBe("Channel");
    store.close();
  });

  it("shows sign-in on the YouTube card and keeps the other forms", async () => {
    const { app, store } = tempApp();
    const response = await app.request("http://127.0.0.1:8787/");
    const html = await response.text();
    const start = html.indexOf('data-platform="youtube"');
    const card = html.slice(start, html.indexOf("</form>", start));
    expect(card).toContain("Sign in");
    expect(card).not.toContain("<input");
    expect(card).toContain("/oauth/youtube/callback");
    expect(html).toContain('name="clientKey"');
    expect(html).toContain('name="accessToken"');
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
