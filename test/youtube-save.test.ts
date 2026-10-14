import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCredentials } from "../src/credentials.js";
import { saveConnection, SettingsError } from "../src/settings/save.js";
import { openStore, type CredentialStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("YouTube credential save", () => {
  it("asks for sign-in instead of a pasted client", () => {
    const store = tempStore();
    expect(() =>
      saveConnection(store, "youtube", {
        clientId: "client-id.apps.googleusercontent.com",
        clientSecret: "secret-value",
        refreshToken: "",
      }),
    ).toThrow(SettingsError);
    expect(store.get("youtube")).toBeNull();
    store.close();
  });

  it("reads an older row without keeping the app secret", () => {
    expect(
      parseCredentials("youtube", {
        clientId: "old-client",
        clientSecret: "old-secret",
        refreshToken: "refresh-1",
        accessToken: "access-1",
      }),
    ).toEqual({
      refreshToken: "refresh-1",
      accessToken: "access-1",
    });
  });
});

function tempStore(): CredentialStore {
  const directory = mkdtempSync(path.join(tmpdir(), "social-analytics-"));
  directories.push(directory);
  return openStore(path.join(directory, "analytics.sqlite"));
}
