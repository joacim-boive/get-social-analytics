import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { registerDataRoutes } from "../api/routes.js";
import { getClient } from "../platforms/client.js";
import { PlatformApiError } from "../platforms/errors.js";
import { exchangeFacebookCode, facebookAppConfig, facebookAuthorizeUrl } from "../platforms/facebook.js";
import { exchangeInstagramCode, instagramAppConfig, instagramAuthorizeUrl } from "../platforms/instagram.js";
import { exchangeTikTokCode } from "../platforms/tiktok.js";
import { exchangeYouTubeCode } from "../platforms/youtube.js";
import type { PlatformId } from "../report/types.js";
import { isPlatformId, platformLabel } from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { isRecord, readString } from "../util.js";
import { assertAllowedOrigin, requestOrigin } from "./origin.js";
import { renderSettingsPage, type PageNotice } from "./page.js";
import { listPublic, toPublic } from "./public.js";
import { saveConnection, SettingsError } from "./save.js";

export type SettingsAppOptions = {
  viewer?: string | null;
  publishableKey?: string | null;
};

export function createSettingsApp(store: CredentialStore, options: SettingsAppOptions = {}): Hono {
  const app = new Hono();
  registerDataRoutes(app, store);

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/", (c) => {
    const origin = requestOrigin(c.req.url, c.req.raw.headers);
    return c.html(
      renderSettingsPage({
        origin,
        connections: listPublic(store),
        notice: readNotice(c.req.query()),
        viewer: options.viewer ?? null,
        publishableKey: options.publishableKey ?? null,
      }),
    );
  });

  app.get("/api/connections", (c) =>
    c.json({ connections: listPublic(store) }),
  );

  app.post("/api/connections/:platform", async (c) => {
    const platform = readPlatform(c.req.param("platform"));
    if (!platform)
      return c.json({ ok: false, message: "Unknown platform." }, 404);
    try {
      const body: unknown = await c.req.json();
      saveConnection(store, platform, body);
      return c.json({
        ok: true,
        message: "Saved.",
        connection: toPublic(store, platform),
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          message: errorMessage(error),
          connection: toPublic(store, platform),
        },
        error instanceof SettingsError ? 400 : 500,
      );
    }
  });

  app.post("/api/connections/facebook/choose", async (c) => {
    const body: unknown = await c.req.json();
    const pageId = isRecord(body) ? readString(body, "pageId") : null;
    const existing = store.get("facebook");
    const page = existing?.credentials.pendingPages?.find((item) => item.id === pageId);
    if (!existing || !page) {
      return c.json({ ok: false, message: "Choose a Page from the list." }, 400);
    }
    store.save(
      "facebook",
      {
        appId: existing.credentials.appId,
        appSecret: existing.credentials.appSecret,
        pageAccessToken: page.accessToken,
        pageId: page.id,
        pendingPages: null,
      },
      { account: { id: page.id, name: page.name, handle: null }, tokenExpiresAt: null },
    );
    try {
      const account = await getClient("facebook").test(store);
      return c.json({
        ok: true,
        message: `Connected as ${account.name}.`,
        connection: toPublic(store, "facebook"),
      });
    } catch (error) {
      return c.json(
        { ok: false, message: errorMessage(error), connection: toPublic(store, "facebook") },
        400,
      );
    }
  });

  app.post("/api/connections/:platform/test", async (c) => {
    const platform = readPlatform(c.req.param("platform"));
    if (!platform)
      return c.json({ ok: false, message: "Unknown platform." }, 404);
    try {
      const body: unknown = await c.req.json();
      saveConnection(store, platform, body);
    } catch (error) {
      return c.json(
        {
          ok: false,
          message: errorMessage(error),
          connection: toPublic(store, platform),
        },
        400,
      );
    }
    try {
      const account = await getClient(platform).test(store);
      return c.json({
        ok: true,
        message: `Connected as ${account.name}.`,
        connection: toPublic(store, platform),
      });
    } catch (error) {
      return c.json({
        ok: false,
        message: errorMessage(error),
        connection: toPublic(store, platform),
      });
    }
  });

  app.get("/oauth/:provider/start", async (c) => {
    const provider = readOAuthProvider(c.req.param("provider"));
    if (!provider)
      return c.redirect(errorRedirect("oauth", "Unknown sign-in provider."));
    try {
      const origin = requestOrigin(c.req.url, c.req.raw.headers);
      const redirectUri = oauthRedirect(origin, provider);
      const state = randomBytes(16).toString("base64url");
      const verifier = pkce();
      await store.saveOAuth(state, {
        provider,
        verifier: verifier.verifier,
        redirectUri,
        createdAt: Date.now(),
      });
      return c.redirect(authorizeUrl(store, provider, redirectUri, state, verifier.challenge));
    } catch (error) {
      return c.redirect(errorRedirect(provider, errorMessage(error)));
    }
  });

  app.get("/oauth/:provider/callback", async (c) => {
    const provider = readOAuthProvider(c.req.param("provider"));
    if (!provider)
      return c.redirect(errorRedirect("oauth", "Unknown sign-in provider."));
    const oauthError = c.req.query("error");
    if (oauthError)
      return c.redirect(
        errorRedirect(provider, c.req.query("error_description") ?? oauthError),
      );
    const state = c.req.query("state");
    const code = c.req.query("code");
    const pending = state ? await store.takeOAuth(state) : null;
    if (!pending || pending.provider !== provider) {
      return c.redirect(errorRedirect(provider, "Sign-in expired. Try again."));
    }
    if (!code)
      return c.redirect(
        errorRedirect(provider, "The platform did not return a code."),
      );
    try {
      const outcome = await storeExchangedCode(store, provider, code, pending);
      if (outcome === "choose") return c.redirect("/?choose=facebook");
      await getClient(provider).test(store);
      return c.redirect(`/?connected=${provider}`);
    } catch (error) {
      return c.redirect(errorRedirect(provider, errorMessage(error)));
    }
  });

  return app;
}

function readPlatform(value: string): PlatformId | null {
  return isPlatformId(value) ? value : null;
}

function readOAuthProvider(value: string): PlatformId | null {
  return isPlatformId(value) ? value : null;
}

function authorizeUrl(
  store: CredentialStore,
  provider: PlatformId,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  if (provider === "instagram") {
    const app = instagramAppConfig(store.get("instagram")?.credentials);
    if (!app) throw new SettingsError("Instagram sign-in is not available yet.");
    return instagramAuthorizeUrl({ appId: app.appId, redirectUri, state });
  }
  if (provider === "facebook") {
    const app = facebookAppConfig(store.get("facebook")?.credentials);
    if (!app) throw new SettingsError("Facebook sign-in is not available yet.");
    return facebookAuthorizeUrl({ appId: app.appId, redirectUri, state });
  }
  if (provider === "tiktok") {
    const connection = store.get("tiktok");
    if (!connection) throw new SettingsError("Save the client key and secret first.");
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", connection.credentials.clientKey);
    url.searchParams.set("scope", "user.info.basic,user.info.stats,video.list");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }
  const connection = store.get("youtube");
  if (!connection) throw new SettingsError("Save the client id and secret first.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", connection.credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function storeExchangedCode(
  store: CredentialStore,
  provider: PlatformId,
  code: string,
  pending: { verifier: string; redirectUri: string },
): Promise<"connected" | "choose"> {
  if (provider === "instagram") {
    const existing = store.get("instagram");
    const app = instagramAppConfig(existing?.credentials);
    if (!app) throw new SettingsError("Instagram sign-in is not available yet.");
    const exchanged = await exchangeInstagramCode({
      appId: app.appId,
      appSecret: app.appSecret,
      code,
      redirectUri: pending.redirectUri,
    });
    store.save(
      "instagram",
      {
        appId: existing?.credentials.appId ?? null,
        appSecret: existing?.credentials.appSecret ?? null,
        accessToken: exchanged.accessToken,
      },
      { account: existing?.account ?? null, tokenExpiresAt: exchanged.expiresAt },
    );
    return "connected";
  }
  if (provider === "facebook") {
    const existing = store.get("facebook");
    const app = facebookAppConfig(existing?.credentials);
    if (!app) throw new SettingsError("Facebook sign-in is not available yet.");
    const exchanged = await exchangeFacebookCode({
      appId: app.appId,
      appSecret: app.appSecret,
      code,
      redirectUri: pending.redirectUri,
      pageId: existing?.credentials.pageId ?? null,
    });
    if (exchanged.status === "choose") {
      store.save(
        "facebook",
        {
          appId: existing?.credentials.appId ?? null,
          appSecret: existing?.credentials.appSecret ?? null,
          pageAccessToken: null,
          pageId: null,
          pendingPages: exchanged.pages,
        },
        { account: null, tokenExpiresAt: null },
      );
      return "choose";
    }
    store.save(
      "facebook",
      {
        appId: existing?.credentials.appId ?? null,
        appSecret: existing?.credentials.appSecret ?? null,
        pageAccessToken: exchanged.pageAccessToken,
        pageId: exchanged.pageId,
        pendingPages: null,
      },
      {
        account: { id: exchanged.pageId, name: exchanged.pageName, handle: null },
        tokenExpiresAt: null,
      },
    );
    return "connected";
  }
  if (provider === "tiktok") {
    const existing = store.get("tiktok");
    if (!existing) throw new SettingsError("Save the client key and secret first.");
    const exchanged = await exchangeTikTokCode({
      clientKey: existing.credentials.clientKey,
      clientSecret: existing.credentials.clientSecret,
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
    });
    store.save(
      "tiktok",
      {
        ...existing.credentials,
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        openId: exchanged.openId ?? existing.credentials.openId,
      },
      { account: existing.account, tokenExpiresAt: exchanged.expiresAt },
    );
    return "connected";
  }
  const existing = store.get("youtube");
  if (!existing) throw new SettingsError("Save the client id and secret first.");
  const exchanged = await exchangeYouTubeCode({
    clientId: existing.credentials.clientId,
    clientSecret: existing.credentials.clientSecret,
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.verifier,
  });
  const refreshToken = exchanged.refreshToken ?? existing.credentials.refreshToken;
  if (!refreshToken) {
    throw new SettingsError("Google did not return a refresh token. Remove the app's access and sign in again.");
  }
  store.save(
    "youtube",
    {
      ...existing.credentials,
      refreshToken,
      accessToken: exchanged.accessToken,
    },
    { account: existing.account, tokenExpiresAt: exchanged.expiresAt },
  );
  return "connected";
}

function readNotice(
  query: Record<string, string | undefined>,
): PageNotice | null {
  if (query.choose === "facebook") {
    return { tone: "ok", text: "Choose the Facebook Page to measure." };
  }
  if (query.connected && isPlatformId(query.connected)) {
    const extra = query.message ? ` ${query.message}` : "";
    return { tone: "ok", text: `${platformLabel(query.connected)} is signed in.${extra}` };
  }
  if (query.error && query.message)
    return { tone: "error", text: query.message };
  return null;
}

function errorRedirect(provider: string, message: string): string {
  return `/?error=${encodeURIComponent(provider)}&message=${encodeURIComponent(message)}`;
}

function oauthRedirect(origin: string, provider: PlatformId): string {
  assertAllowedOrigin(origin);
  return `${origin}/oauth/${provider}/callback`;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function errorMessage(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof PlatformApiError) {
    const message = error.message.endsWith(".")
      ? error.message
      : `${error.message}.`;
    return `${message} ${error.action}`;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
