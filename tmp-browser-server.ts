import { getRequestListener } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSettingsApp } from "./src/settings/routes.js";
import { openStore } from "./src/store.js";

const directory = mkdtempSync(path.join(tmpdir(), "settings-browser-"));
const store = openStore(path.join(directory, "analytics.sqlite"));
const app = createSettingsApp(store);
const server = createServer(
  getRequestListener((request) => app.fetch(request)),
);
server.listen(8799, "127.0.0.1", () => {
  console.log(`ready ${directory}`);
});
