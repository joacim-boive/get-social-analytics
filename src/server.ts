import { Hono } from "hono";
import { createSettingsApp } from "./settings/routes.js";
import { openStore } from "./store.js";

const settings = createSettingsApp(openStore(databasePath()));
const app = new Hono();

app.all("*", (c) => settings.fetch(c.req.raw));

export default app;

function databasePath(): string | undefined {
  if (process.env.VERCEL !== "1") return undefined;
  return "/tmp/get-social-analytics/analytics.sqlite";
}
