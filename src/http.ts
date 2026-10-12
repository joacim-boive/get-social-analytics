import { getRequestListener } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createMcpServer } from "./mcp/server.js";
import { createSettingsApp } from "./settings/routes.js";
import { openStore } from "./store.js";

const port = readPort(process.env.PORT);
const store = openStore();
const app = createSettingsApp(store);
const listener = getRequestListener((request) => app.fetch(request));

const server = createServer((request, response) => {
  const pathName = (request.url ?? "/").split("?")[0];
  if (pathName === "/mcp") {
    void handleMcp(request, response).catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "MCP request failed",
      );
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "MCP request failed" }));
      }
    });
    return;
  }
  void listener(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Settings http://127.0.0.1:${port}`);
  console.log(`MCP      http://127.0.0.1:${port}/mcp`);
});

async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
  }
  const mcp = createMcpServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  response.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response, parsed);
}

function readPort(value: string | undefined): number {
  if (!value) return 8787;
  const portNumber = Number(value);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    return 8787;
  return portNumber;
}
