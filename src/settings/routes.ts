import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { getClient } from "../platforms/client.js";
import { PlatformApiError } from "../platforms/errors.js";
import { exchangeTikTokCode } from "../platforms/tiktok.js";
import { exchangeYouTubeCode } from "../platforms/youtube.js";
import type { PlatformId } from "../report/types.js";
import { isPlatformId } from "../report/types.js";
import type { CredentialStore } from "../store.js";
import { renderSettingsPage, type PageNotice } from "./page.js";
import { listPublic, toPublic } from "./public.js";
import { saveConnection, SettingsError } from "./save.js";

type PendingOAuth = {
  provider: "tiktok" | "youtube";
  verifier: string;
  redirectUri: string;
  createdAt: number;
};

const pendingOAuth = new Map<string, PendingOAuth>();

export function createSettingsApp(store: CredentialStore): Hono {
  const app = new Hono();

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/", (c) => {
    const origin = localOrigin(c.req.url);
    return c.html(
      renderSettingsPage({
        origin,
        connections: listPublic(store),
        notice: readNotice(c.req.query()),
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

  app.get("/oauth/:provider/start", (c) => {
    const provider = readOAuthProvider(c.req.param("provider"));
    if (!provider)
      return c.redirect(errorRedirect("oauth", "Unknown sign-in provider."));
    try {
      const redirectUri = oauthRedirect(c.req.url, provider);
      const state = randomBytes(16).toString("base64url");
      const verifier = pkce();
      pendingOAuth.set(state, {
        provider,
        verifier: verifier.verifier,
        redirectUri,
        createdAt: Date.now(),
      });
      prunePending();
      if (provider === "tiktok") {
        const connection = store.get("tiktok");
        if (!connection)
          return c.redirect(
            errorRedirect(provider, "Save the client key and secret first."),
          );
        const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
        url.searchParams.set("client_key", connection.credentials.clientKey);
        url.searchParams.set(
          "scope",
          "user.info.basic,user.info.stats,video.list",
        );
        url.searchParams.set("response_type", "code");
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", verifier.challenge);
        url.searchParams.set("code_challenge_method", "S256");
        return c.redirect(url.toString());
      }
      const connection = store.get("youtube");
      if (!connection)
        return c.redirect(
          errorRedirect(provider, "Save the client id and secret first."),
        );
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
      url.searchParams.set("code_challenge", verifier.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return c.redirect(url.toString());
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
    const pending = state ? pendingOAuth.get(state) : undefined;
    if (state) pendingOAuth.delete(state);
    if (
      !pending ||
      pending.provider !== provider ||
      Date.now() - pending.createdAt > 10 * 60 * 1000
    ) {
      return c.redirect(errorRedirect(provider, "Sign-in expired. Try again."));
    }
    if (!code)
      return c.redirect(
        errorRedirect(provider, "The platform did not return a code."),
      );
    try {
      if (provider === "tiktok") {
        const existing = store.get("tiktok");
        if (!existing)
          return c.redirect(
            errorRedirect(provider, "Save the client key and secret first."),
          );
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
            clientKey: existing.credentials.clientKey,
            clientSecret: existing.credentials.clientSecret,
            accessToken: exchanged.accessToken,
            refreshToken: exchanged.refreshToken,
            openId: exchanged.openId ?? existing.credentials.openId,
          },
          { account: existing.account, tokenExpiresAt: exchanged.expiresAt },
        );
      } else {
        const existing = store.get("youtube");
        if (!existing)
          return c.redirect(
            errorRedirect(provider, "Save the client id and secret first."),
          );
        const exchanged = await exchangeYouTubeCode({
          clientId: existing.credentials.clientId,
          clientSecret: existing.credentials.clientSecret,
          code,
          redirectUri: pending.redirectUri,
          codeVerifier: pending.verifier,
        });
        const refreshToken =
          exchanged.refreshToken ?? existing.credentials.refreshToken;
        if (!refreshToken) {
          return c.redirect(
            errorRedirect(
              provider,
              "Google did not return a refresh token. Remove the app's access and sign in again.",
            ),
          );
        }
        store.save(
          "youtube",
          {
            clientId: existing.credentials.clientId,
            clientSecret: existing.credentials.clientSecret,
            refreshToken,
            accessToken: exchanged.accessToken,
          },
          { account: existing.account, tokenExpiresAt: exchanged.expiresAt },
        );
      }
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

function readOAuthProvider(value: string): "tiktok" | "youtube" | null {
  if (value === "tiktok" || value === "youtube") return value;
  return null;
}

function readNotice(
  query: Record<string, string | undefined>,
): PageNotice | null {
  if (query.connected === "tiktok" || query.connected === "youtube") {
    const extra = query.message ? ` ${query.message}` : "";
    return {
      tone: "ok",
      text: `${query.connected === "tiktok" ? "TikTok" : "YouTube"} is signed in.${extra}`,
    };
  }
  if (query.error && query.message)
    return { tone: "error", text: query.message };
  return null;
}

function errorRedirect(provider: string, message: string): string {
  return `/?error=${encodeURIComponent(provider)}&message=${encodeURIComponent(message)}`;
}

function oauthRedirect(
  requestUrl: string,
  provider: "tiktok" | "youtube",
): string {
  const url = new URL(requestUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new SettingsError("Sign-in is only available from this computer.");
  }
  return `${url.protocol}//${url.host}/oauth/${provider}/callback`;
}

function localOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function prunePending(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, pending] of pendingOAuth) {
    if (pending.createdAt < cutoff) pendingOAuth.delete(state);
  }
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
