import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/store.js";

type RemoteRow = Record<string, unknown>;

type Remote = {
  connections: RemoteRow[];
  oauth: RemoteRow[];
  locks: RemoteRow[];
  failLocks: boolean;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@libsql/client");
  vi.doUnmock("../src/util.js");
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
});

describe("hosted Turso store", () => {
  it("pulls one user's rows and ignores another user's", async () => {
    const remote = createRemote();
    remote.connections.push(
      connectionRow("user-1", "youtube", "secret-from-turso"),
    );
    remote.connections.push(
      connectionRow("user-2", "instagram", "other-user-secret"),
    );
    const store = await openFor("user-1", remote);
    expect(store.get("youtube")?.credentials).toMatchObject({
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "secret-from-turso",
    });
    expect(store.get("youtube")?.account).toMatchObject({ name: "Ada" });
    expect(store.get("instagram")).toBeNull();
    store.close();
  });

  it("drains a save into the remote connection row", async () => {
    const remote = createRemote();
    const store = await openFor("user-1", remote);
    store.save("youtube", {
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "secret-value",
      refreshToken: null,
      accessToken: null,
    });
    await store.drain();
    expect(remote.connections).toHaveLength(1);
    expect(remote.connections[0]).toMatchObject({
      user_id: "user-1",
      platform: "youtube",
    });
    expect(String(remote.connections[0]?.credentials)).toContain(
      "secret-value",
    );
    store.close();
  });

  it("holds the refresh lock for the critical section and releases it afterwards", async () => {
    const remote = createRemote();
    const store = await openFor("user-1", remote);
    const value = await store.withLock("youtube", async () => {
      expect(remote.locks).toHaveLength(1);
      return "held";
    });
    expect(value).toBe("held");
    expect(remote.locks).toEqual([]);
    await expect(
      store.withLock("youtube", async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");
    expect(remote.locks).toEqual([]);
    store.close();
  });

  it("stores an OAuth pending row and drops it after it is taken or expires", async () => {
    const remote = createRemote();
    const store = await openFor("user-1", remote);
    const pending = {
      provider: "youtube" as const,
      verifier: "verifier-value",
      redirectUri: "http://127.0.0.1:8787/oauth/youtube/callback",
      createdAt: Date.now(),
    };
    await store.saveOAuth("state-fresh", pending);
    expect(await store.takeOAuth("state-fresh")).toMatchObject({
      provider: "youtube",
      verifier: "verifier-value",
    });
    expect(await store.takeOAuth("state-fresh")).toBeNull();

    await store.saveOAuth("state-old", {
      ...pending,
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    expect(await store.takeOAuth("state-old")).toBeNull();
    store.close();
  });

  it("stops waiting for a refresh lock that never clears", async () => {
    const remote = createRemote();
    remote.failLocks = true;
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = await openFor("user-1", remote, async () => {
      now += 20_000;
    });
    await expect(store.withLock("youtube", async () => "ok")).rejects.toThrow(
      "Timed out waiting for youtube.",
    );
    store.close();
  });

  it("refuses to open when Turso is not configured", async () => {
    vi.resetModules();
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    vi.doMock("@libsql/client", () => ({
      createClient: () => {
        throw new Error("should not connect");
      },
    }));
    const { openHostedStore } = await import("../src/store-turso.js");
    await expect(openHostedStore("user-1")).rejects.toThrow(
      "Turso is not configured.",
    );
  });
});

async function openFor(
  userId: string,
  remote: Remote,
  delay?: () => Promise<void>,
): Promise<CredentialStore> {
  process.env.TURSO_DATABASE_URL = "libsql://example.turso.io";
  process.env.TURSO_AUTH_TOKEN = "turso-token";
  vi.resetModules();
  vi.doMock("@libsql/client", () => ({
    createClient: () => clientFor(remote),
  }));
  if (delay) {
    vi.doMock("../src/util.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/util.js")>(
          "../src/util.js",
        );
      return { ...actual, delay };
    });
  }
  const { openHostedStore } = await import("../src/store-turso.js");
  return openHostedStore(userId);
}

function connectionRow(
  userId: string,
  platform: string,
  secret: string,
): RemoteRow {
  const credentials =
    platform === "youtube"
      ? {
          clientId: "client.apps.googleusercontent.com",
          clientSecret: secret,
          refreshToken: "refresh-token",
          accessToken: null,
        }
      : { accessToken: secret, appSecret: "app-secret" };
  return {
    user_id: userId,
    platform,
    credentials: JSON.stringify(credentials),
    account_id: "channel-1",
    account_name: "Ada",
    account_handle: null,
    token_expires_at: null,
    updated_at: "2026-11-07T00:00:00.000Z",
  };
}

function createRemote(): Remote {
  return { connections: [], oauth: [], locks: [], failLocks: false };
}

function clientFor(remote: Remote): {
  execute(statement: {
    sql: string;
    args?: readonly unknown[];
  }): Promise<{ rows: RemoteRow[] }>;
  batch(
    statements: ReadonlyArray<
      string | { sql: string; args?: readonly unknown[] }
    >,
  ): Promise<Array<{ rows: RemoteRow[] }>>;
} {
  const execute = async (statement: {
    sql: string;
    args?: readonly unknown[];
  }) => {
    const params = [...(statement.args ?? [])];
    const { sql } = statement;
    if (sql.includes("FROM connections WHERE user_id")) {
      return {
        rows: remote.connections.filter((row) => row.user_id === params[0]),
      };
    }
    if (sql.startsWith("INSERT INTO connections")) {
      const row = {
        user_id: params[0],
        platform: params[1],
        credentials: params[2],
        account_id: params[3],
        account_name: params[4],
        account_handle: params[5],
        token_expires_at: params[6],
        updated_at: params[7],
      };
      const existing = remote.connections.find(
        (entry) =>
          entry.user_id === row.user_id && entry.platform === row.platform,
      );
      if (existing) Object.assign(existing, row);
      else remote.connections.push(row);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO oauth_pending")) {
      const row = {
        state: params[0],
        user_id: params[1],
        provider: params[2],
        verifier: params[3],
        redirect_uri: params[4],
        created_at: params[5],
      };
      const existing = remote.oauth.find((entry) => entry.state === row.state);
      if (existing) Object.assign(existing, row);
      else remote.oauth.push(row);
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM oauth_pending WHERE created_at")) {
      const cutoff = params[0];
      remote.oauth = remote.oauth.filter(
        (row) => Number(row.created_at) >= Number(cutoff),
      );
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM oauth_pending WHERE state")) {
      remote.oauth = remote.oauth.filter((row) => row.state !== params[0]);
      return { rows: [] };
    }
    if (sql.includes("FROM oauth_pending WHERE state")) {
      return {
        rows: remote.oauth.filter(
          (row) => row.state === params[0] && row.user_id === params[1],
        ),
      };
    }
    if (
      sql.includes("DELETE FROM refresh_locks") &&
      sql.includes("expires_at")
    ) {
      remote.locks = remote.locks.filter((row) => {
        const same = row.user_id === params[0] && row.name === params[1];
        return !(same && Number(row.expires_at) < Number(params[2]));
      });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO refresh_locks")) {
      if (remote.failLocks) throw new Error("locked");
      const occupied = remote.locks.some(
        (row) => row.user_id === params[0] && row.name === params[1],
      );
      if (occupied) throw new Error("constraint");
      remote.locks.push({
        user_id: params[0],
        name: params[1],
        owner: params[2],
        expires_at: params[3],
      });
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM refresh_locks") && sql.includes("owner")) {
      remote.locks = remote.locks.filter(
        (row) =>
          !(
            row.user_id === params[0] &&
            row.name === params[1] &&
            row.owner === params[2]
          ),
      );
      return { rows: [] };
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  };

  return {
    execute,
    async batch(statements) {
      const results = [];
      for (const statement of statements) {
        results.push(
          typeof statement === "string"
            ? { rows: [] }
            : await execute(statement),
        );
      }
      return results;
    },
  };
}
