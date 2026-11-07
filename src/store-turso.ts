import { createClient, type Client } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { isPlatformId } from "./report/types.js";
import {
  isOAuthProvider,
  openStore,
  type CredentialStore,
  type PersistedConnection,
  type StoredOAuth,
} from "./store.js";
import { delay, isRecord } from "./util.js";

const oauthTtlMs = 10 * 60 * 1000;
const lockTtlMs = 60_000;

let schemaReady: Promise<void> | null = null;

export async function openHostedStore(userId: string): Promise<CredentialStore> {
  const remote = turso();
  await ensureSchema(remote);
  const local = openStore(":memory:");
  await pull(remote, userId, local);
  let chain = Promise.resolve();
  const queue = (job: () => Promise<void>) => {
    chain = chain.then(job);
  };

  return {
    get: (platform) => local.get(platform),
    save(platform, credentials, details) {
      const saved = local.save(platform, credentials, details);
      const row = local.exportRows().find((entry) => entry.platform === platform);
      if (row) queue(() => upsertConnection(remote, userId, row));
      return saved;
    },
    async withLock(name, fn) {
      await chain;
      const owner = await acquireLock(remote, userId, name);
      try {
        await pull(remote, userId, local);
        const result = await fn();
        await chain;
        return result;
      } finally {
        await releaseLock(remote, userId, name, owner);
      }
    },
    async saveOAuth(state, pending) {
      await remote.execute({
        sql: `INSERT INTO oauth_pending (state, user_id, provider, verifier, redirect_uri, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(state) DO UPDATE SET
                user_id = excluded.user_id,
                provider = excluded.provider,
                verifier = excluded.verifier,
                redirect_uri = excluded.redirect_uri,
                created_at = excluded.created_at`,
        args: [state, userId, pending.provider, pending.verifier, pending.redirectUri, pending.createdAt],
      });
      await remote.execute({
        sql: "DELETE FROM oauth_pending WHERE created_at < ?",
        args: [Date.now() - oauthTtlMs],
      });
    },
    async peekOAuth(state) {
      const result = await remote.execute({
        sql: "SELECT provider, verifier, redirect_uri, created_at FROM oauth_pending WHERE state = ? AND user_id = ?",
        args: [state, userId],
      });
      return readOAuth(result.rows[0]);
    },
    async takeOAuth(state) {
      const result = await remote.execute({
        sql: "SELECT provider, verifier, redirect_uri, created_at FROM oauth_pending WHERE state = ? AND user_id = ?",
        args: [state, userId],
      });
      await remote.execute({
        sql: "DELETE FROM oauth_pending WHERE state = ? AND user_id = ?",
        args: [state, userId],
      });
      return readOAuth(result.rows[0]);
    },
    drain: () => chain,
    close() {
      local.close();
    },
  };
}

function turso(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("Turso is not configured.");
  return createClient({ url, authToken });
}

function ensureSchema(client: Client): Promise<void> {
  schemaReady ??= client.batch([
    `CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      credentials TEXT NOT NULL,
      account_id TEXT,
      account_name TEXT,
      account_handle TEXT,
      token_expires_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, platform)
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_pending (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_locks (
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    )`,
  ], "write").then(() => undefined);
  return schemaReady;
}

async function pull(client: Client, userId: string, local: ReturnType<typeof openStore>): Promise<void> {
  const result = await client.execute({
    sql: `SELECT platform, credentials, account_id, account_name, account_handle, token_expires_at, updated_at
          FROM connections WHERE user_id = ?`,
    args: [userId],
  });
  const rows: PersistedConnection[] = [];
  for (const row of result.rows) {
    const parsed = readConnection(row);
    if (parsed) rows.push(parsed);
  }
  local.importRows(rows);
}

async function upsertConnection(client: Client, userId: string, row: PersistedConnection): Promise<void> {
  await client.execute({
    sql: `INSERT INTO connections (
            user_id, platform, credentials, account_id, account_name, account_handle, token_expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, platform) DO UPDATE SET
            credentials = excluded.credentials,
            account_id = excluded.account_id,
            account_name = excluded.account_name,
            account_handle = excluded.account_handle,
            token_expires_at = excluded.token_expires_at,
            updated_at = excluded.updated_at`,
    args: [
      userId,
      row.platform,
      row.credentials,
      row.accountId,
      row.accountName,
      row.accountHandle,
      row.tokenExpiresAt,
      row.updatedAt,
    ],
  });
}

async function acquireLock(client: Client, userId: string, name: string): Promise<string> {
  const owner = randomBytes(16).toString("hex");
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      await client.batch([
        {
          sql: "DELETE FROM refresh_locks WHERE user_id = ? AND name = ? AND expires_at < ?",
          args: [userId, name, Date.now()],
        },
        {
          sql: "INSERT INTO refresh_locks (user_id, name, owner, expires_at) VALUES (?, ?, ?, ?)",
          args: [userId, name, owner, Date.now() + lockTtlMs],
        },
      ], "write");
      return owner;
    } catch {
      await delay(40);
    }
  }
  throw new Error(`Timed out waiting for ${name}.`);
}

async function releaseLock(client: Client, userId: string, name: string, owner: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM refresh_locks WHERE user_id = ? AND name = ? AND owner = ?",
    args: [userId, name, owner],
  });
}

function readConnection(row: unknown): PersistedConnection | null {
  const record = asRecord(row);
  if (!record) return null;
  const platform = text(record, "platform");
  const credentials = text(record, "credentials");
  const updatedAt = text(record, "updated_at");
  if (!platform || !isPlatformId(platform) || !credentials || !updatedAt) return null;
  return {
    platform,
    credentials,
    accountId: text(record, "account_id"),
    accountName: text(record, "account_name"),
    accountHandle: text(record, "account_handle"),
    tokenExpiresAt: text(record, "token_expires_at"),
    updatedAt,
  };
}

function readOAuth(row: unknown): StoredOAuth | null {
  const record = asRecord(row);
  if (!record) return null;
  const provider = text(record, "provider");
  const verifier = text(record, "verifier");
  const redirectUri = text(record, "redirect_uri");
  const createdAt = numberValue(record.created_at);
  if (!provider || !isOAuthProvider(provider) || !verifier || !redirectUri || createdAt === null) {
    return null;
  }
  if (Date.now() - createdAt > oauthTtlMs) return null;
  return { provider, verifier, redirectUri, createdAt };
}

function asRecord(row: unknown): Record<string, unknown> | null {
  return isRecord(row) ? row : null;
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
