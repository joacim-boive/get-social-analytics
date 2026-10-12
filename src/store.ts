import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseCredentials, type CredentialMap, type StoredConnection } from "./credentials.js";
import type { AccountProfile, PlatformId } from "./report/types.js";
import { delay, isNodeError, isRecord } from "./util.js";

type ConnectionRow = {
  platform: string;
  credentials: string;
  account_id: string | null;
  account_name: string | null;
  account_handle: string | null;
  token_expires_at: string | null;
  updated_at: string;
};

export type CredentialStore = {
  get<K extends PlatformId>(platform: K): StoredConnection<K> | null;
  save<K extends PlatformId>(
    platform: K,
    credentials: CredentialMap[K],
    details?: { account?: AccountProfile | null; tokenExpiresAt?: string | null },
  ): StoredConnection<K>;
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
};

const DEFAULT_PATH = fileURLToPath(new URL("../data/analytics.sqlite", import.meta.url));

export function openStore(dbPath = DEFAULT_PATH): CredentialStore {
  const directory = path.dirname(dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      platform TEXT PRIMARY KEY,
      credentials TEXT NOT NULL,
      account_id TEXT,
      account_name TEXT,
      account_handle TEXT,
      token_expires_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  tighten(dbPath);

  const selectOne = db.prepare("SELECT * FROM connections WHERE platform = ?");
  const upsert = db.prepare(`
    INSERT INTO connections (platform, credentials, account_id, account_name, account_handle, token_expires_at, updated_at)
    VALUES (@platform, @credentials, @account_id, @account_name, @account_handle, @token_expires_at, @updated_at)
    ON CONFLICT(platform) DO UPDATE SET
      credentials = excluded.credentials,
      account_id = excluded.account_id,
      account_name = excluded.account_name,
      account_handle = excluded.account_handle,
      token_expires_at = excluded.token_expires_at,
      updated_at = excluded.updated_at
  `);

  return {
    get(platform) {
      const row = selectOne.get(platform);
      if (!row) return null;
      return readRow(platform, row);
    },
    save(platform, credentials, details) {
      const existing = selectOne.get(platform);
      const previous = existing ? readRow(platform, existing) : null;
      const account = details && "account" in details ? (details.account ?? null) : (previous?.account ?? null);
      const tokenExpiresAt =
        details && "tokenExpiresAt" in details ? (details.tokenExpiresAt ?? null) : (previous?.tokenExpiresAt ?? null);
      const updatedAt = new Date().toISOString();
      upsert.run({
        platform,
        credentials: JSON.stringify(credentials),
        account_id: account?.id ?? null,
        account_name: account?.name ?? null,
        account_handle: account?.handle ?? null,
        token_expires_at: tokenExpiresAt,
        updated_at: updatedAt,
      });
      tighten(dbPath);
      const saved = selectOne.get(platform);
      if (!saved) throw new Error(`Failed to save ${platform} credentials.`);
      return readRow(platform, saved);
    },
    withLock(name, fn) {
      return withFileLock(directory, name, fn);
    },
    close() {
      db.close();
    },
  };
}

function readRow<K extends PlatformId>(platform: K, row: unknown): StoredConnection<K> {
  if (!isConnectionRow(row)) throw new Error("Credential row is unreadable.");
  const parsed: unknown = JSON.parse(row.credentials);
  return {
    platform,
    credentials: parseCredentials(platform, parsed),
    account: row.account_id
      ? { id: row.account_id, name: row.account_name ?? row.account_id, handle: row.account_handle }
      : null,
    tokenExpiresAt: row.token_expires_at,
    updatedAt: row.updated_at,
  };
}

function isConnectionRow(value: unknown): value is ConnectionRow {
  if (!isRecord(value)) return false;
  return typeof value.platform === "string" && typeof value.credentials === "string" && typeof value.updated_at === "string";
}

function tighten(dbPath: string): void {
  chmodSync(dbPath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const extra = `${dbPath}${suffix}`;
    if (existsSync(extra)) chmodSync(extra, 0o600);
  }
}

async function withFileLock<T>(directory: string, name: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, `${name}.lock`);
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
        return await fn();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      await clearStaleLock(lockPath);
      if (Date.now() - started > 15_000) throw new Error(`Timed out waiting for ${name}.`);
      await delay(40);
    }
  }
}

async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, "r");
    const text = await handle.readFile("utf8");
    await handle.close();
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) {
      await unlink(lockPath).catch(() => undefined);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    await unlink(lockPath).catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
