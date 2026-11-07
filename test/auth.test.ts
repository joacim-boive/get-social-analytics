import { afterEach, describe, expect, it } from "vitest";
import {
  clerkAuthorizedParties,
  readDevBrowserToken,
  settleBrowserAuth,
  signInRedirect,
  unauthenticatedResponse,
  withSessionCookies,
} from "../src/auth.js";

const devKey = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;
const liveKey = `pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`;
const origin = "https://get-social-analytics.vercel.app";

afterEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.VERCEL_URL;
});

describe("Clerk sign-in return", () => {
  it("sends a development sign-in back to the app with the dev browser token", () => {
    const location = new URL(
      signInRedirect({
        signInUrl: "",
        origin,
        back: `${origin}/`,
        publishableKey: devKey,
        devBrowserToken: "dvb_test",
      }),
    );
    expect(location.origin).toBe("https://example.accounts.dev");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("redirect_url")).toBe(`${origin}/`);
    expect(location.searchParams.get("__clerk_db_jwt")).toBe("dvb_test");
  });

  it("leaves the dev browser token off production sign-in", () => {
    const location = new URL(
      signInRedirect({
        signInUrl: "https://accounts.example.com/sign-in",
        origin: "https://example.com",
        back: "https://example.com/reports",
        publishableKey: liveKey,
        devBrowserToken: "dvb_test",
      }),
    );
    expect(location.origin).toBe("https://accounts.example.com");
    expect(location.searchParams.get("redirect_url")).toBe("https://example.com/reports");
    expect(location.searchParams.has("__clerk_db_jwt")).toBe(false);
  });

  it("reads the dev browser token from the cookie set by the handshake", () => {
    const request = new Request(`${origin}/`, {
      headers: {
        cookie: "other=1; __clerk_db_jwt=dvb_cookie; __session=abc",
      },
    });
    expect(readDevBrowserToken(request)).toBe("dvb_cookie");
  });

  it("prefers the unsuffixed dev browser cookie", () => {
    const request = new Request(`${origin}/`, {
      headers: {
        cookie: "__clerk_db_jwt_suffix=dvb_old; __clerk_db_jwt=dvb_new",
      },
    });
    expect(readDevBrowserToken(request)).toBe("dvb_new");
  });

  it("keeps the handshake cookies when Clerk redirects back to the app", () => {
    const headers = new Headers({
      location: `${origin}/`,
    });
    headers.append("set-cookie", "__clerk_db_jwt=dvb_test; Path=/; Secure; SameSite=None");
    headers.append("set-cookie", "__client_uat=0; Path=/; Secure");
    const request = new Request("https://internal/?__clerk_handshake=token", {
      headers: { "x-forwarded-host": "get-social-analytics.vercel.app", "x-forwarded-proto": "https" },
    });
    const response = unauthenticatedResponse({
      request,
      origin,
      signInUrl: "",
      publishableKey: devKey,
      headers,
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${origin}/`);
    expect(response.headers.getSetCookie()).toEqual([
      "__clerk_db_jwt=dvb_test; Path=/; Secure; SameSite=None",
      "__client_uat=0; Path=/; Secure",
    ]);
  });

  it("redirects to sign-in with the stored dev browser after the handshake", () => {
    const request = new Request(`${origin}/reports?days=7`, {
      headers: { cookie: "__clerk_db_jwt=dvb_test" },
    });
    const response = unauthenticatedResponse({
      request,
      origin,
      signInUrl: "",
      publishableKey: devKey,
      headers: new Headers(),
    });
    const location = new URL(response.headers.get("location") ?? "");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(location.searchParams.get("redirect_url")).toBe(`${origin}/reports?days=7`);
    expect(location.searchParams.get("__clerk_db_jwt")).toBe("dvb_test");
  });

  it("does not follow a clerk redirect to another site", () => {
    const headers = new Headers({ location: "https://evil.example/phish" });
    const response = unauthenticatedResponse({
      request: new Request(`${origin}/`),
      origin,
      signInUrl: "",
      publishableKey: devKey,
      headers,
    });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://example.accounts.dev");
  });

  it("copies session cookies onto the signed-in page", () => {
    const headers = new Headers();
    headers.append("set-cookie", "__session=signed; Path=/; HttpOnly; Secure");
    const response = withSessionCookies(Response.json({ ok: true }), headers);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.getSetCookie()).toEqual(["__session=signed; Path=/; HttpOnly; Secure"]);
  });

  it("turns an API sign-in redirect into JSON and leaves the page redirect alone", async () => {
    const redirect = new Response(null, {
      status: 307,
      headers: { location: "https://example.accounts.dev/sign-in" },
    });
    const api = settleBrowserAuth(new Request(`${origin}/api/connections/youtube`), redirect);
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ ok: false, message: "Sign in again, then retry." });
    const page = settleBrowserAuth(new Request(`${origin}/`), redirect);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://example.accounts.dev/sign-in");
    const oauth = settleBrowserAuth(new Request(`${origin}/oauth/youtube/start`), redirect);
    expect(oauth.status).toBe(307);
  });

  it("authorizes the host the browser actually used", () => {
    process.env.APP_ORIGIN = origin;
    process.env.VERCEL_URL = "get-social-analytics-git-preview.vercel.app";
    expect(clerkAuthorizedParties("https://get-social-analytics-git-preview.vercel.app")).toEqual([
      origin,
      "https://get-social-analytics-git-preview.vercel.app",
    ]);
    expect(clerkAuthorizedParties("https://evil.example")).toEqual([
      origin,
      "https://get-social-analytics-git-preview.vercel.app",
    ]);
  });
});
