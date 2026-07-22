import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../args.js";
import { readGithubToken } from "../github/githubAuth.js";
import { runGithubLogin, runGithubLogout, runGithubStatus } from "./github.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-github-cmd-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

/** Wraps a plain `(url, init) => Promise<Response>` fake into something matching `typeof fetch`'s real parameter types (`RequestInfo | URL`) — real fetch call sites only ever pass a plain string URL here, so tests can assert on that directly. */
function fetchMock(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => impl(String(input), init));
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

describe("parseArgs: falcon github", () => {
  it("parses `falcon github login --token`", () => {
    expect(parseArgs(["github", "login", "--token"])).toEqual({
      type: "github",
      action: "login",
      token: true,
    });
  });

  it("parses `falcon github login --client-id <id>`", () => {
    expect(parseArgs(["github", "login", "--client-id", "abc123"])).toEqual({
      type: "github",
      action: "login",
      token: false,
      clientId: "abc123",
    });
  });

  it("parses `falcon github login` with neither flag", () => {
    expect(parseArgs(["github", "login"])).toEqual({
      type: "github",
      action: "login",
      token: false,
    });
  });

  it("parses `falcon github logout`", () => {
    expect(parseArgs(["github", "logout"])).toEqual({
      type: "github",
      action: "logout",
      token: false,
    });
  });

  it("parses `falcon github status`", () => {
    expect(parseArgs(["github", "status"])).toEqual({
      type: "github",
      action: "status",
      token: false,
    });
  });

  it("rejects an unknown falcon github action", () => {
    expect(() => parseArgs(["github", "bogus"])).toThrow(/Unknown "falcon github" action/);
  });

  it("rejects an unknown falcon github login flag", () => {
    expect(() => parseArgs(["github", "login", "--bogus"])).toThrow(
      /Unknown "falcon github login" flag/,
    );
  });

  it("never accepts a token as a bare argv value — --token takes no inline value", () => {
    // `--token gho_realtoken` parses `gho_realtoken` as an unrelated
    // trailing token, never as the flag's value — the flag alone toggles
    // the stdin-prompt path; a token pasted on the command line would leak
    // into shell history and `ps`, which is exactly what this guards against.
    expect(() => parseArgs(["github", "login", "--token", "gho_realtoken"])).toThrow(
      /Unknown "falcon github login" flag/,
    );
  });
});

describe("runGithubLogin", () => {
  it("--token: saves the pasted PAT and reports success", async () => {
    const { write, lines } = collectWrites();
    const code = await runGithubLogin(
      { useToken: true },
      { homeDir, write, readSecretLine: async () => "gho_pastedtoken" },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain("Saved GitHub token");
    expect(readGithubToken(homeDir)).toMatchObject({ token: "gho_pastedtoken", method: "pat" });
  });

  it("--token: reports failure and saves nothing for an empty paste", async () => {
    const { write, lines } = collectWrites();
    const code = await runGithubLogin(
      { useToken: true },
      { homeDir, write, readSecretLine: async () => "" },
    );

    expect(code).toBe(1);
    expect(lines.join("")).toContain("no token entered");
    expect(readGithubToken(homeDir)).toBeNull();
  });

  it("--token: the REAL (non-injected) prompt reads a pasted token via its non-TTY fallback without echoing it back on stdout", async () => {
    // Exercises `defaultReadSecretLine` itself (no `readSecretLine` override) rather than the
    // test seam every other case here uses — this is what actually runs in a real headless/
    // piped-stdin context (CI, this test runner). The raw-mode masking branch needs a real
    // TTY and isn't exercised here, but this proves the prompt never echoes the raw token
    // through `process.stdout.write` regardless of which branch runs.
    const { Readable } = await import("node:stream");
    const fakeStdin = Readable.from(["gho_realpastetoken\n"]) as unknown as NodeJS.ReadStream;
    Object.assign(fakeStdin, { isTTY: false });
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });

    try {
      const { write, lines } = collectWrites();
      const code = await runGithubLogin({ useToken: true }, { homeDir, write });

      expect(code).toBe(0);
      expect(lines.join("")).toContain("Saved GitHub token");
      expect(readGithubToken(homeDir)).toMatchObject({
        token: "gho_realpastetoken",
        method: "pat",
      });
      expect(stdoutChunks.join("")).not.toContain("gho_realpastetoken");
    } finally {
      stdoutSpy.mockRestore();
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });

  it("device flow: fails fast with an explicit message when no client id is configured", async () => {
    const { write, lines } = collectWrites();
    const code = await runGithubLogin({ useToken: false }, { homeDir, write, env: {} });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("--token");
    expect(readGithubToken(homeDir)).toBeNull();
  });

  it("device flow: --client-id wins over FALCON_GITHUB_CLIENT_ID", async () => {
    const fetchImpl = fetchMock(async (url) => {
      if (url.includes("device/code")) {
        return jsonResponse({
          device_code: "dc-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        });
      }
      return jsonResponse({ access_token: "gho_device", scope: "repo" });
    });
    const { write, lines } = collectWrites();

    const code = await runGithubLogin(
      { useToken: false, clientId: "explicit-client" },
      {
        homeDir,
        write,
        env: { FALCON_GITHUB_CLIENT_ID: "env-client" },
        fetchImpl,
        sleep: async () => {},
      },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain("ABCD-1234");
    expect(readGithubToken(homeDir)).toMatchObject({ token: "gho_device", method: "device-flow" });
    const deviceCodeCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("device/code"),
    );
    expect(deviceCodeCall).toBeDefined();
    expect(bodyOf(deviceCodeCall?.[1]).client_id).toBe("explicit-client");
  });

  it("device flow: falls back to FALCON_GITHUB_CLIENT_ID when --client-id is omitted", async () => {
    const fetchImpl = fetchMock(async (url) => {
      if (url.includes("device/code")) {
        return jsonResponse({
          device_code: "dc-1",
          user_code: "WXYZ-9999",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        });
      }
      return jsonResponse({ access_token: "gho_device2", scope: "repo" });
    });

    const code = await runGithubLogin(
      { useToken: false },
      {
        homeDir,
        write: () => {},
        env: { FALCON_GITHUB_CLIENT_ID: "env-client" },
        fetchImpl,
        sleep: async () => {},
      },
    );

    expect(code).toBe(0);
    const deviceCodeCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("device/code"),
    );
    expect(deviceCodeCall).toBeDefined();
    expect(bodyOf(deviceCodeCall?.[1]).client_id).toBe("env-client");
  });
});

describe("runGithubLogout", () => {
  it("clears a saved token and reports success", async () => {
    await runGithubLogin(
      { useToken: true },
      { homeDir, write: () => {}, readSecretLine: async () => "gho_x" },
    );
    expect(readGithubToken(homeDir)).not.toBeNull();

    const { write, lines } = collectWrites();
    const code = runGithubLogout({ homeDir, write });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("Logged out");
    expect(readGithubToken(homeDir)).toBeNull();
  });
});

describe("runGithubStatus", () => {
  it("reports not-connected when no token is stored", async () => {
    const { write, lines } = collectWrites();
    const code = await runGithubStatus({ homeDir, write });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("not connected");
  });

  it("reports the logged-in user and scopes for a valid token", async () => {
    await runGithubLogin(
      { useToken: true },
      { homeDir, write: () => {}, readSecretLine: async () => "gho_valid" },
    );
    const fetchImpl = fetchMock(async () =>
      jsonResponse({ login: "octocat" }, true, 200, { "x-oauth-scopes": "repo, read:checks" }),
    );

    const { write, lines } = collectWrites();
    const code = await runGithubStatus({ homeDir, write, fetchImpl });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("octocat");
    expect(lines.join("")).toContain("repo, read:checks");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gho_valid");
  });

  it("reports invalid token when GitHub rejects it", async () => {
    await runGithubLogin(
      { useToken: true },
      { homeDir, write: () => {}, readSecretLine: async () => "gho_stale" },
    );
    const fetchImpl = fetchMock(async () => jsonResponse({}, false, 401));

    const { write, lines } = collectWrites();
    const code = await runGithubStatus({ homeDir, write, fetchImpl });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid token");
  });
});
