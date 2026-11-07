import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { createSettingsApp } from "./src/settings/routes.js";
import { openStore } from "./src/store.js";

const port = Number(process.env.PORT ?? 8799);
const store = openStore(
  process.env.BROWSER_DB ?? ".tmp-browser/analytics.sqlite",
);
const listener = getRequestListener((request) =>
  createSettingsApp(store).fetch(request),
);
const server = createServer((request, response) => {
  void listener(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ready http://127.0.0.1:${port}`);
});
