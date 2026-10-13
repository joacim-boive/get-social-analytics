import { Hono } from "hono";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  requireBrowserUser,
  withSessionCookies,
} from "./auth.js";
import { handleMcp } from "./mcp/http.js";
import { isAllowedOrigin, requestOrigin } from "./settings/origin.js";
import { createSettingsApp } from "./settings/routes.js";
import { openHostedStore } from "./store-turso.js";

const app = new Hono();

app.get("/.well-known/oauth-protected-resource", (c) => resourceMetadata(c.req.raw));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => resourceMetadata(c.req.raw));
app.get("/.well-known/oauth-authorization-server", async (c) => {
  try {
    return c.json(await authorizationServerMetadata());
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Authorization metadata failed");
    return c.json({ error: "Authorization server metadata is unavailable." }, 502);
  }
});

app.all("/mcp", (c) => handleMcp(c.req.raw));

app.all("*", async (c) => {
  try {
    const user = await requireBrowserUser(c.req.raw);
    if (user instanceof Response) return user;
    const store = await openHostedStore(user.userId);
    try {
      const settings = createSettingsApp(store, {
        viewer: user.email,
        publishableKey: user.publishableKey,
      });
      const response = await settings.fetch(c.req.raw);
      await store.drain();
      return withSessionCookies(response, user.sessionHeaders);
    } finally {
      store.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Request failed");
    return c.json({ error: "The server is not ready." }, 500);
  }
});

export default app;

function resourceMetadata(request: Request): Response {
  const origin = requestOrigin(request.url, request.headers);
  if (!isAllowedOrigin(origin)) {
    return Response.json({ error: "This host is not allowed." }, { status: 400 });
  }
  return Response.json(protectedResourceMetadata(origin), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
