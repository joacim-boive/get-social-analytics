import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpUnauthorized, requireMcpUser } from "../auth.js";
import { requestOrigin } from "../settings/origin.js";
import { openHostedStore } from "../store-turso.js";
import { createMcpServer } from "./server.js";

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  const origin = requestOrigin(request.url, request.headers);
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return cors(new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405 }));
  }
  let userId: string;
  try {
    const user = await requireMcpUser(request);
    if (user instanceof Response) return cors(user);
    userId = user.userId;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP authentication failed");
    return cors(mcpUnauthorized(origin));
  }
  const store = await openHostedStore(userId);
  const mcp = createMcpServer(store);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await mcp.connect(transport);
    return cors(await transport.handleRequest(request));
  } finally {
    try {
      await store.drain();
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      store.close();
    }
  }
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  headers.set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  headers.append("Access-Control-Expose-Headers", "WWW-Authenticate");
  return new Response(response.body, { status: response.status, headers });
}
