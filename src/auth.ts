import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { isAllowedOrigin, productionOrigin, requestOrigin } from "./settings/origin.js";

export type SignedInUser = {
  userId: string;
  email: string | null;
  publishableKey: string;
  sessionHeaders: Headers;
};

type ClerkKeys = {
  secretKey: string;
  publishableKey: string;
};

let client: ClerkClient | null = null;

export function clerkFrontendApi(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!decoded.endsWith("$")) throw new Error("Clerk publishable key is invalid.");
  return decoded.slice(0, -1);
}

export function clerkAccountPortal(publishableKey: string): string {
  const frontend = clerkFrontendApi(publishableKey);
  const dev = frontend.match(/^(.+)\.clerk\.accounts\.dev$/);
  if (dev?.[1]) return `https://${dev[1]}.accounts.dev`;
  return `https://${frontend}`;
}

export async function requireBrowserUser(request: Request): Promise<SignedInUser | Response> {
  const keys = clerkKeys();
  const origin = requestOrigin(request.url, request.headers);
  if (!isAllowedOrigin(origin)) {
    return Response.json({ error: "This host is not allowed." }, { status: 400 });
  }
  const state = await clerk().authenticateRequest(request, {
    ...keys,
    authorizedParties: clerkAuthorizedParties(origin),
  });
  const redirect = redirectFromClerkHeaders(state.headers, request, origin, keys.publishableKey);
  if (state.status === "handshake") {
    return redirect ?? clerkRedirect(state.headers);
  }
  if (redirect) return redirect;
  if (!state.isAuthenticated) {
    return signInRedirectResponse(request, origin, state.signInUrl, keys.publishableKey);
  }
  const userId = state.toAuth().userId;
  if (!userId) {
    return signInRedirectResponse(request, origin, state.signInUrl, keys.publishableKey);
  }
  const email = await allowedEmail(userId);
  if (email === false) {
    return Response.json({ error: "This account cannot open the settings page." }, { status: 403 });
  }
  return { userId, email, publishableKey: keys.publishableKey, sessionHeaders: state.headers };
}

export async function requireMcpUser(request: Request): Promise<SignedInUser | Response> {
  const keys = clerkKeys();
  const origin = requestOrigin(request.url, request.headers);
  if (!isAllowedOrigin(origin)) {
    return mcpUnauthorized(origin);
  }
  const state = await clerk().authenticateRequest(request, {
    ...keys,
    acceptsToken: "oauth_token",
  });
  if (!state.isAuthenticated) return mcpUnauthorized(origin);
  const userId = state.toAuth().userId;
  if (!userId) return mcpUnauthorized(origin);
  const email = await allowedEmail(userId);
  if (email === false) return mcpUnauthorized(origin);
  return { userId, email, publishableKey: keys.publishableKey, sessionHeaders: new Headers() };
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  const keys = clerkKeys();
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [`https://${clerkFrontendApi(keys.publishableKey)}`],
    scopes_supported: ["openid", "profile", "email"],
    bearer_methods_supported: ["header"],
  };
}

export async function authorizationServerMetadata(): Promise<unknown> {
  const keys = clerkKeys();
  const issuer = `https://${clerkFrontendApi(keys.publishableKey)}`;
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error("Clerk authorization server metadata is unavailable.");
  return response.json() as Promise<unknown>;
}

export function mcpUnauthorized(origin: string): Response {
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  return new Response(JSON.stringify({ error: "Sign in to use this MCP server." }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="openid profile email"`,
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    },
  });
}

function clerk(): ClerkClient {
  client ??= createClerkClient(clerkKeys());
  return client;
}

function clerkKeys(): ClerkKeys {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) throw new Error("Clerk is not configured.");
  return { secretKey, publishableKey };
}

export function clerkAuthorizedParties(origin: string): string[] {
  const values = new Set<string>([productionOrigin()]);
  if (isAllowedOrigin(origin)) values.add(origin);
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) values.add(`https://${vercelUrl}`);
  return [...values];
}

function currentUrl(request: Request, origin: string): string {
  try {
    const url = new URL(request.url);
    return `${origin}${url.pathname}${url.search}`;
  } catch {
    return `${origin}/`;
  }
}

export function readDevBrowserToken(request: Request): string | null {
  try {
    const fromQuery = new URL(request.url).searchParams.get("__clerk_db_jwt");
    if (fromQuery) return fromQuery;
  } catch {
    // Some runtimes pass a relative request URL.
  }
  const header = request.headers.get("cookie");
  if (!header) return null;
  let suffixed: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    if (!raw) continue;
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (name === "__clerk_db_jwt") return value;
    if (name.startsWith("__clerk_db_jwt_")) suffixed = value;
  }
  return suffixed;
}

export function signInRedirect(args: {
  signInUrl: string;
  origin: string;
  back: string;
  publishableKey: string;
  devBrowserToken?: string | null;
}): string {
  const portal = `${clerkAccountPortal(args.publishableKey)}/sign-in`;
  let signIn: URL;
  try {
    signIn = new URL(args.signInUrl, args.origin);
  } catch {
    signIn = new URL(portal);
  }
  if (signIn.origin === new URL(args.origin).origin) signIn = new URL(portal);
  signIn.searchParams.set("redirect_url", args.back);
  // Development sessions belong to the dev browser. The Account Portal returns
  // to this host only when that same token is on the sign-in URL.
  if (args.publishableKey.startsWith("pk_test_") && args.devBrowserToken) {
    signIn.searchParams.set("__clerk_db_jwt", args.devBrowserToken);
  }
  return signIn.toString();
}

export function unauthenticatedResponse(args: {
  request: Request;
  origin: string;
  signInUrl: string;
  publishableKey: string;
  headers: Headers;
}): Response {
  const redirect = redirectFromClerkHeaders(args.headers, args.request, args.origin, args.publishableKey);
  if (redirect) return redirect;
  return signInRedirectResponse(args.request, args.origin, args.signInUrl, args.publishableKey);
}

export function withSessionCookies(response: Response, headers: Headers): Response {
  const cookies = headers.getSetCookie();
  if (cookies.length === 0) return response;
  const next = new Response(response.body, response);
  for (const cookie of cookies) next.headers.append("set-cookie", cookie);
  return next;
}

function signInRedirectResponse(
  request: Request,
  origin: string,
  signInUrl: string,
  publishableKey: string,
): Response {
  const location = signInRedirect({
    signInUrl,
    origin,
    back: currentUrl(request, origin),
    publishableKey,
    devBrowserToken: readDevBrowserToken(request),
  });
  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function redirectFromClerkHeaders(
  headers: Headers,
  request: Request,
  origin: string,
  publishableKey: string,
): Response | null {
  const location = headers.get("location");
  if (!location || !isClerkRedirect(location, request, origin, publishableKey)) return null;
  return clerkRedirect(headers);
}

function isClerkRedirect(location: string, request: Request, origin: string, publishableKey: string): boolean {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return false;
  }
  const back = currentUrl(request, origin);
  if (target.href === back) return false;
  let app: URL;
  try {
    app = new URL(origin);
  } catch {
    return false;
  }
  if (target.origin === app.origin) return true;
  try {
    const frontend = new URL(`https://${clerkFrontendApi(publishableKey)}`);
    const portal = new URL(clerkAccountPortal(publishableKey));
    return target.origin === frontend.origin || target.origin === portal.origin;
  } catch {
    return false;
  }
}

function clerkRedirect(headers: Headers): Response {
  const responseHeaders = new Headers();
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    responseHeaders.set(key, value);
  });
  for (const cookie of headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }
  if (!responseHeaders.has("cache-control")) {
    responseHeaders.set("cache-control", "no-store");
  }
  return new Response(null, { status: 307, headers: responseHeaders });
}

async function allowedEmail(userId: string): Promise<string | null | false> {
  const user = await clerk().users.getUser(userId);
  const primary = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId);
  const email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  const allowed = process.env.ALLOWED_CLERK_EMAIL?.trim().toLowerCase();
  if (!allowed) return email;
  const addresses = user.emailAddresses.map((entry) => entry.emailAddress.toLowerCase());
  if (!addresses.includes(allowed)) return false;
  return email;
}
