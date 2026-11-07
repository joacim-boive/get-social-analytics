import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConnection } from "../src/settings/save.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blank secret saves", () => {
  it("keeps stored Instagram secrets and clears expiry when a new token is pasted", () => {
    const store = tempStore();
    saveConnection(store, "instagram", {
      accessToken: "igaatoken1234",
      appSecret: "appsecret1234",
    });
    store.save(
      "instagram",
      { accessToken: "igaatoken1234", appSecret: "appsecret1234" },
      { tokenExpiresAt: "2026-12-01T00:00:00.000Z" },
    );
    saveConnection(store, "instagram", { accessToken: "", appSecret: "" });
    expect(store.get("instagram")?.credentials).toMatchObject({
      accessToken: "igaatoken1234",
      appSecret: "appsecret1234",
    });
    expect(store.get("instagram")?.tokenExpiresAt).toBe(
      "2026-12-01T00:00:00.000Z",
    );

    saveConnection(store, "instagram", {
      accessToken: "igaatoken5678",
      appSecret: "",
    });
    expect(store.get("instagram")?.credentials.accessToken).toBe(
      "igaatoken5678",
    );
    expect(store.get("instagram")?.credentials.appSecret).toBe("appsecret1234");
    expect(store.get("instagram")?.tokenExpiresAt).toBeNull();
    store.close();
  });

  it("keeps a stored Facebook page token when the field is left blank", () => {
    const store = tempStore();
    store.save(
      "facebook",
      { pageAccessToken: "page-token-1234", pageId: "998877" },
      { tokenExpiresAt: "2026-12-01T00:00:00.000Z" },
    );
    saveConnection(store, "facebook", { pageAccessToken: "" });
    expect(store.get("facebook")?.credentials).toMatchObject({
      pageAccessToken: "page-token-1234",
      pageId: "998877",
    });
    expect(store.get("facebook")?.tokenExpiresAt).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    store.close();
  });

  it("keeps stored TikTok secrets and the open id when the token fields are blank", () => {
    const store = tempStore();
    store.save(
      "tiktok",
      {
        clientKey: "client-key",
        clientSecret: "client-secret",
        accessToken: "access-token-1234",
        refreshToken: "refresh-token-1234",
        openId: "open-id",
      },
      { tokenExpiresAt: "2026-12-01T00:00:00.000Z" },
    );
    saveConnection(store, "tiktok", {
      clientKey: "",
      clientSecret: "",
      accessToken: "",
      refreshToken: "",
    });
    expect(store.get("tiktok")?.credentials).toMatchObject({
      clientKey: "client-key",
      clientSecret: "client-secret",
      accessToken: "access-token-1234",
      refreshToken: "refresh-token-1234",
      openId: "open-id",
    });
    expect(store.get("tiktok")?.tokenExpiresAt).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    store.close();
  });
});

function tempStore(): CredentialStore {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  return openStore(path.join(directory, "analytics.sqlite"));
}
