import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { inclusiveDays } from "../src/report/period.js";
import type { AnalyticsReport } from "../src/report/types.js";
import { saveConnection } from "../src/settings/save.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP tools", () => {
  it("lists saved accounts without secrets", async () => {
    const store = tempStore();
    saveConnection(store, "youtube", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "secret-value",
      refreshToken: "refresh-token-value",
    });
    const client = await connect(store);
    try {
      const listed = await client.listTools();
      const analytics = listed.tools.find(
        (tool) => tool.name === "get_analytics",
      );
      expect(analytics?.description).toContain("last_30_days");
      const result = await client.callTool({
        name: "list_platforms",
        arguments: {},
      });
      const body = JSON.parse(toolText(result)) as {
        platforms: Array<{ platform: string; connected: boolean }>;
      };
      expect(
        body.platforms.find((platform) => platform.platform === "youtube"),
      ).toMatchObject({
        connected: true,
      });
      expect(toolText(result)).not.toContain("secret-value");
      expect(toolText(result)).not.toContain("refresh-token-value");
    } finally {
      await client.close();
      store.close();
    }
  });

  it("keeps one platform error inside a report for every platform", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("live API");
      }),
    );
    const store = tempStore();
    saveConnection(store, "youtube", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "secret-value",
      refreshToken: "refresh-token-value",
    });
    const client = await connect(store);
    try {
      const result = await client.callTool({
        name: "get_analytics",
        arguments: { platforms: "all", include: "summary" },
      });
      expect(result.isError).not.toBe(true);
      const report = JSON.parse(toolText(result)) as AnalyticsReport;
      const instagram = report.platforms.find(
        (platform) => platform.platform === "instagram",
      );
      const youtube = report.platforms.find(
        (platform) => platform.platform === "youtube",
      );
      expect(instagram?.status).toBe("not_configured");
      expect(youtube?.status).toBe("error");
      expect(youtube?.error?.code).toBe("network");
      expect(toolText(result)).not.toContain("refresh-token-value");
    } finally {
      await client.close();
      store.close();
    }
  });

  it("accepts the last_30_days preset", async () => {
    const store = tempStore();
    const client = await connect(store);
    try {
      const result = await client.callTool({
        name: "get_analytics",
        arguments: {
          platforms: "instagram",
          period: { preset: "last_30_days" },
          include: "summary",
        },
      });
      expect(result.isError).not.toBe(true);
      const report = JSON.parse(toolText(result)) as AnalyticsReport;
      const period = report.platforms[0]?.period;
      expect(period?.requested).toEqual({ preset: "last_30_days" });
      expect(
        inclusiveDays(period?.applied.start ?? "", period?.applied.end ?? ""),
      ).toBe(30);
    } finally {
      await client.close();
      store.close();
    }
  });
});

async function connect(store: CredentialStore): Promise<Client> {
  const mcp = createMcpServer(store);
  const client = new Client({
    name: "social-analytics-test",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    mcp.connect(serverTransport),
  ]);
  return client;
}

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("Tool returned no content.");
  }
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("Tool returned no content.");
  const block = content.find((entry): entry is { type: "text"; text: string } =>
    isTextBlock(entry),
  );
  if (!block) throw new Error("Tool returned no text.");
  return block.text;
}

function isTextBlock(entry: unknown): entry is { type: "text"; text: string } {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

function tempStore(): CredentialStore {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  return openStore(path.join(directory, "analytics.sqlite"));
}
