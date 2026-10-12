import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";
import { openStore } from "./store.js";

const store = openStore();
const server = createMcpServer(store);
const transport = new StdioServerTransport();
await server.connect(transport);
