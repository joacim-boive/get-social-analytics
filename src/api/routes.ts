import type { Context, Hono } from "hono";
import {
  collectReports,
  describePlatforms,
  normalizeQuery,
} from "../platforms/client.js";
import { toComparison } from "../report/compare.js";
import { formatReport } from "../report/format.js";
import { PeriodError } from "../report/period.js";
import type { CredentialStore } from "../store.js";
import { ApiQueryError, argsFromBody, argsFromQuery } from "./query.js";

export function registerDataRoutes(app: Hono, store: CredentialStore): void {
  app.get("/api/platforms", (c) =>
    c.json({ platforms: describePlatforms(store) }),
  );

  app.get("/api/analytics", (c) => serveReport(c, store, "analytics"));
  app.get("/api/analytics/:platform", (c) =>
    serveReport(c, store, "analytics"),
  );
  app.post("/api/analytics", (c) => serveReport(c, store, "analytics"));
  app.post("/api/analytics/:platform", (c) =>
    serveReport(c, store, "analytics"),
  );

  app.get("/api/content", (c) => serveReport(c, store, "content"));
  app.get("/api/content/:platform", (c) => serveReport(c, store, "content"));
  app.post("/api/content", (c) => serveReport(c, store, "content"));
  app.post("/api/content/:platform", (c) => serveReport(c, store, "content"));
}

async function serveReport(
  c: Context,
  store: CredentialStore,
  mode: "analytics" | "content",
): Promise<Response> {
  try {
    const args =
      c.req.method === "GET"
        ? argsFromQuery(c.req.query(), c.req.param("platform"))
        : argsFromBody(await readJsonBody(c), c.req.param("platform"));
    const markdown = args.format === "markdown";
    const normalized = normalizeQuery(
      markdown
        ? mode === "content"
          ? { ...args, include: "content" }
          : args
        : { ...args, include: "both", format: "json" },
    );
    const report = await collectReports(
      store,
      normalized.platforms,
      normalized.query,
      markdown ? mode : "analytics",
    );
    if (markdown) {
      return c.text(formatReport(report, "markdown"), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    return c.json(toComparison(report, normalized.query.period), 200, {
      "Cache-Control": "no-store",
    });
  } catch (error) {
    if (
      error instanceof ApiQueryError &&
      error.message === "Unknown platform."
    ) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ApiQueryError || error instanceof PeriodError) {
      return c.json({ error: error.message }, 400);
    }
    console.error(
      error instanceof Error ? error.message : "Analytics request failed",
    );
    return c.json({ error: "The analytics request failed." }, 500);
  }
}

async function readJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiQueryError("Invalid JSON.");
  }
}
