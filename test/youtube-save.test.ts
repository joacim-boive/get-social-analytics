import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConnection, SettingsError } from "../src/settings/save.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("YouTube credential save", () => {
  it("saves the client id and secret before a refresh token exists", () => {
    const store = tempStore();
    saveConnection(store, "youtube", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "secret-value",
      refreshToken: "",
    });
    const saved = store.get("youtube");
    expect(saved?.credentials.clientId).toBe(
      "client-id.apps.googleusercontent.com",
    );
    expect(saved?.credentials.clientSecret).toBe("secret-value");
    expect(saved?.credentials.refreshToken).toBeNull();
    store.close();
  });

  it("keeps a refresh token obtained by sign-in when the field is left blank", () => {
    const store = tempStore();
    saveConnection(store, "youtube", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "secret-value",
      refreshToken: "refresh-from-google",
    });
    saveConnection(store, "youtube", {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "",
      refreshToken: "",
    });
    expect(store.get("youtube")?.credentials.refreshToken).toBe(
      "refresh-from-google",
    );
    store.close();
  });

  it("still requires the client id and secret", () => {
    const store = tempStore();
    expect(() =>
      saveConnection(store, "youtube", {
        clientId: "",
        clientSecret: "",
        refreshToken: "",
      }),
    ).toThrow(SettingsError);
    store.close();
  });
});

function tempStore(): CredentialStore {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  return openStore(path.join(directory, "analytics.sqlite"));
}
