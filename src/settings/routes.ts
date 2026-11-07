import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { registerDataRoutes } from "../api/routes.js";
import { getClient } from "../platforms/client.js";
import { PlatformApiError } from "../platforms/errors.js";
import {
  encodeFacebookPages,
  exchangeFacebookCode,
  exchangeInstagramCode,
  facebookAuthorizeUrl,
  instagramAuthorizeUrl,
  parseFacebookPages,
} from "../platforms/meta-oauth.js";
import { exchangeTikTokCode } from "../platforms/tiktok.js";
import { exchangeYouTubeCode } from "../platforms/youtube.js";
import type { PlatformId } from "../report/types.js";
import { platformLabel, isPlatformId } from "../report/types.js";
import { isOAuthProvider, type CredentialStore, type OAuthProvider } from "../store.js";
import { isRecord } from "../util.js";
import { loginReady, serverApps } from "./apps.js";
import { assertAllowedOrigin, requestOrigin } from "./origin.js";
import { renderSettingsPage, type PageChoice, type PageNotice } from "./page.js";
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

  app.get("/", async (c) => {
    const origin = requestOrigin(c.req.url, c.req.raw.headers);
    const query = c.req.query();
    const pageChoice = await readPageChoice(store, query.choose, query.state);
    const notice = pageChoice
      ? null
      : query.choose === "facebook"
        ? { tone: "error" as const, text: "That Page choice expired. Sign in again." }
        : readNotice(query);
    return c.html(
      renderSettingsPage({
        origin,
        connections: listPublic(store),
        notice,
        viewer: options.viewer ?? null,
        publishableKey: options.publishableKey ?? null,
        login: {
          instagram: loginReady("instagram"),
          facebook: loginReady("facebook"),
          tiktok: loginReady("tiktok"),
          youtube: loginReady("youtube"),
        },
        pageChoice,
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

  app.post("/api/connections/:platform/test", async (c) => {
    const platform = readPlatform(c.req.param("platform"));
    if (!platform)
      return c.json({ ok: false, message: "Unknown platform." }, 404);
    try {
      const body: unknown = await c.req.json();
      if (!isBlankForm(body)) {
        saveConnection(store, platform, body);
      } else if (!store.get(platform)) {
        return c.json(
          {
            ok: false,
            message: "Sign in or save credentials first.",
            connection: toPublic(store, platform),
          },
          400,
        );
      }
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
      const url = authorizeUrl({
        provider,
        store,
        redirectUri,
        state,
        challenge: verifier.challenge,
      });
      await store.saveOAuth(state, {
        provider,
        verifier: verifier.verifier,
        redirectUri,
        createdAt: Date.now(),
      });
      return c.redirect(url);
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
      const choice = await finishSignIn(store, provider, pending.redirectUri, pending.verifier, code);
      if (choice) return c.redirect(`/?choose=facebook&state=${encodeURIComponent(choice)}`);
      await getClient(provider).test(store);
      return c.redirect(`/?connected=${provider}`);
    } catch (error) {
      return c.redirect(errorRedirect(provider, errorMessage(error)));
    }
  });

  app.post("/oauth/facebook/choose", async (c) => {
    const body = await c.req.parseBody();
    const state = typeof body.state === "string" ? body.state : "";
    const pageId = typeof body.pageId === "string" ? body.pageId : "";
    const pending = state ? await store.takeOAuth(state) : null;
    if (!pending || pending.provider !== "facebook") {
      return c.redirect(errorRedirect("facebook", "That Page choice expired. Sign in again."));
    }
    const page = parseFacebookPages(pending.verifier)?.find((entry) => entry.id === pageId);
    if (!page) {
      return c.redirect(errorRedirect("facebook", "Choose a Page this account can analyze."));
    }
    try {
      store.save(
        "facebook",
        { pageAccessToken: page.accessToken, pageId: page.id },
        { tokenExpiresAt: null },
      );
      await getClient("facebook").test(store);
      return c.redirect("/?connected=facebook");
    } catch (error) {
      return c.redirect(errorRedirect("facebook", errorMessage(error)));
    }
  });

  return app;
}

function readPlatform(value: string): PlatformId | null {
  return isPlatformId(value) ? value : null;
}

function readOAuthProvider(value: string): OAuthProvider | null {
  return isOAuthProvider(value) ? value : null;
}

function readNotice(
  query: Record<string, string | undefined>,
): PageNotice | null {
  if (query.connected && isPlatformId(query.connected)) {
    const extra = query.message ? ` ${query.message}` : "";
    return {
      tone: "ok",
      text: `${platformLabel(query.connected)} is signed in.${extra}`,
    };
  }
  if (query.error && query.message)
    return { tone: "error", text: query.message };
  return null;
}

async function readPageChoice(
  store: CredentialStore,
  choose: string | undefined,
  state: string | undefined,
): Promise<PageChoice | null> {
  if (choose !== "facebook" || !state) return null;
  const pending = await store.peekOAuth(state);
  if (!pending || pending.provider !== "facebook") return null;
  const pages = parseFacebookPages(pending.verifier);
  if (!pages) return null;
  return {
    state,
    pages: pages.map((page) => ({ id: page.id, name: page.name })),
  };
}

function authorizeUrl(args: {
  provider: OAuthProvider;
  store: CredentialStore;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const apps = serverApps();
  if (args.provider === "instagram") {
    if (!apps.meta) throw new SettingsError("Instagram sign-in is not configured on this server.");
    return instagramAuthorizeUrl({
      appId: apps.meta.appId,
      redirectUri: args.redirectUri,
      state: args.state,
    });
  }
  if (args.provider === "facebook") {
    if (!apps.meta) throw new SettingsError("Facebook sign-in is not configured on this server.");
    return facebookAuthorizeUrl({
      appId: apps.meta.appId,
      redirectUri: args.redirectUri,
      state: args.state,
    });
  }
  if (args.provider === "tiktok") {
    const app = apps.tiktok ?? storedTikTok(args.store);
    if (!app) throw new SettingsError("Save the client key and secret first.");
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", app.clientKey);
    url.searchParams.set("scope", "user.info.basic,user.info.stats,video.list");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("state", args.state);
    url.searchParams.set("code_challenge", args.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }
  const app = apps.youtube ?? storedYouTube(args.store);
  if (!app) throw new SettingsError("Save the client id and secret first.");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function finishSignIn(
  store: CredentialStore,
  provider: OAuthProvider,
  redirectUri: string,
  verifier: string,
  code: string,
): Promise<string | null> {
  const apps = serverApps();
  if (provider === "instagram") {
    if (!apps.meta) throw new SettingsError("Instagram sign-in is not configured on this server.");
    const exchanged = await exchangeInstagramCode({
      appId: apps.meta.appId,
      appSecret: apps.meta.appSecret,
      code,
      redirectUri,
    });
    store.save(
      "instagram",
      { accessToken: exchanged.accessToken, appSecret: apps.meta.appSecret },
      { tokenExpiresAt: exchanged.expiresAt },
    );
    return null;
  }
  if (provider === "facebook") {
    if (!apps.meta) throw new SettingsError("Facebook sign-in is not configured on this server.");
    const pages = await exchangeFacebookCode({
      appId: apps.meta.appId,
      appSecret: apps.meta.appSecret,
      code,
      redirectUri,
    });
    const only = pages.length === 1 ? pages[0] : null;
    if (!only) {
      const choice = randomBytes(16).toString("base64url");
      await store.saveOAuth(choice, {
        provider: "facebook",
        verifier: encodeFacebookPages(pages),
        redirectUri,
        createdAt: Date.now(),
      });
      return choice;
    }
    store.save(
      "facebook",
      { pageAccessToken: only.accessToken, pageId: only.id },
      { tokenExpiresAt: null },
    );
    return null;
  }
  if (provider === "tiktok") {
    const existing = store.get("tiktok");
    const app = apps.tiktok ?? storedTikTok(store);
    if (!app) throw new SettingsError("Save the client key and secret first.");
    const exchanged = await exchangeTikTokCode({
      clientKey: app.clientKey,
      clientSecret: app.clientSecret,
      code,
      redirectUri,
      codeVerifier: verifier,
    });
    store.save(
      "tiktok",
      {
        clientKey: app.clientKey,
        clientSecret: app.clientSecret,
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        openId: exchanged.openId ?? existing?.credentials.openId ?? null,
      },
      { account: existing?.account ?? null, tokenExpiresAt: exchanged.expiresAt },
    );
    return null;
  }
  const existing = store.get("youtube");
  const app = apps.youtube ?? storedYouTube(store);
  if (!app) throw new SettingsError("Save the client id and secret first.");
  const exchanged = await exchangeYouTubeCode({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code,
    redirectUri,
    codeVerifier: verifier,
  });
  const sameClient = existing?.credentials.clientId === app.clientId;
  const refreshToken =
    exchanged.refreshToken ?? (sameClient ? (existing?.credentials.refreshToken ?? null) : null);
  if (!refreshToken) {
    throw new SettingsError(
      "Google did not return a refresh token. Remove the app's access and sign in again.",
    );
  }
  store.save(
    "youtube",
    {
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken,
      accessToken: exchanged.accessToken,
    },
    { account: existing?.account ?? null, tokenExpiresAt: exchanged.expiresAt },
  );
  return null;
}

function storedTikTok(store: CredentialStore): { clientKey: string; clientSecret: string } | null {
  const existing = store.get("tiktok");
  if (!existing) return null;
  return {
    clientKey: existing.credentials.clientKey,
    clientSecret: existing.credentials.clientSecret,
  };
}

function storedYouTube(store: CredentialStore): { clientId: string; clientSecret: string } | null {
  const existing = store.get("youtube");
  if (!existing) return null;
  return {
    clientId: existing.credentials.clientId,
    clientSecret: existing.credentials.clientSecret,
  };
}

function errorRedirect(provider: string, message: string): string {
  return `/?error=${encodeURIComponent(provider)}&message=${encodeURIComponent(message)}`;
}

function oauthRedirect(origin: string, provider: OAuthProvider): string {
  assertAllowedOrigin(origin);
  return `${origin}/oauth/${provider}/callback`;
}

function isBlankForm(body: unknown): boolean {
  if (!isRecord(body)) return true;
  return Object.values(body).every(
    (value) => typeof value !== "string" || value.trim() === "",
  );
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
