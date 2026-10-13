import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { isAllowedOrigin, productionOrigin, requestOrigin } from "./settings/origin.js";

export type SignedInUser = {
  userId: string;
  email: string | null;
  publishableKey: string;
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
    authorizedParties: parties(),
  });
  if (state.status === "handshake") {
    return new Response(null, { status: 307, headers: state.headers });
  }
  if (!state.isAuthenticated) {
    return Response.redirect(signInRedirect(state.signInUrl, origin, currentUrl(request, origin)), 307);
  }
  const userId = state.toAuth().userId;
  if (!userId) {
    return Response.redirect(signInRedirect(state.signInUrl, origin, currentUrl(request, origin)), 307);
  }
  const email = await allowedEmail(userId);
  if (email === false) {
    return Response.json({ error: "This account cannot open the settings page." }, { status: 403 });
  }
  return { userId, email, publishableKey: keys.publishableKey };
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
  return { userId, email, publishableKey: keys.publishableKey };
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

function parties(): string[] {
  const values = new Set<string>([productionOrigin()]);
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

function signInRedirect(signInUrl: string, origin: string, back: string): string {
  const portal = `${clerkAccountPortal(clerkKeys().publishableKey)}/sign-in`;
  let signIn: URL;
  try {
    signIn = new URL(signInUrl, origin);
  } catch {
    signIn = new URL(portal);
  }
  if (signIn.origin === new URL(origin).origin) signIn = new URL(portal);
  signIn.searchParams.set("redirect_url", back);
  return signIn.toString();
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
