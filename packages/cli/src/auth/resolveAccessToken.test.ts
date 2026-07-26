import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FalconCredentials, writeCredentials } from "./credentials.js";
import { resolveAccessToken } from "./resolveAccessToken.js";

let homeDir: string;

const keyMaterial: FalconCredentials["keyMaterial"] = {
  mode: "plaintext-fallback",
  bundle: "s",
};

function credentialsWith(refreshToken: string): FalconCredentials {
  return { refreshToken, keyMaterial };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-resolve-access-token-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("resolveAccessToken", () => {
  it("returns the access token on a normal refresh, without touching disk", async () => {
    const credentials = credentialsWith("rt-1");
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ accessToken: "at-1", refreshToken: "rt-2" });

    const token = await resolveAccessToken(credentials, {
      backendUrl: "http://example.invalid",
      homeDir,
      fetchImpl,
    });

    expect(token).toBe("at-1");
  });

  it("re-reads access.key and retries once when the refresh token already rotated on disk", async () => {
    // Simulates another process (the daemon's machineClient.ts, or a long-running
    // `falcon claude` session) having already rotated the refresh token and persisted
    // the new one to access.key between when THIS process read its stale copy and when
    // it presents it to the server.
    const staleCredentials = credentialsWith("rt-stale");
    writeCredentials(credentialsWith("rt-current"), homeDir);

    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { refreshToken: string };
      if (body.refreshToken === "rt-stale") return jsonResponse({ error: "dead" }, 401);
      if (body.refreshToken === "rt-current") {
        return jsonResponse({ accessToken: "at-current", refreshToken: "rt-next" });
      }
      throw new Error(`unexpected refresh token presented: ${body.refreshToken}`);
    };

    const token = await resolveAccessToken(staleCredentials, {
      backendUrl: "http://example.invalid",
      homeDir,
      fetchImpl,
    });

    expect(token).toBe("at-current");
  });

  it("still fails honestly when the on-disk copy is the same dead token", async () => {
    const credentials = credentialsWith("rt-dead");
    writeCredentials(credentials, homeDir);

    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "dead" }, 401);

    const token = await resolveAccessToken(credentials, {
      backendUrl: "http://example.invalid",
      homeDir,
      fetchImpl,
    });

    expect(token).toBeNull();
  });

  it("returns null with no retry when nothing is on disk at all", async () => {
    const credentials = credentialsWith("rt-dead");
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "dead" }, 401);

    const token = await resolveAccessToken(credentials, {
      backendUrl: "http://example.invalid",
      homeDir,
      fetchImpl,
    });

    expect(token).toBeNull();
  });
});
