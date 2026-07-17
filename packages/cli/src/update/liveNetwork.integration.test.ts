/**
 * Real network round-trip coverage for the self-update engine.
 *
 * Every other test in `packages/cli/src/update/` exercises
 * `fetchLatestVersion`/`downloadAndVerify`/`applyUpdate` against a fully
 * in-memory `fetchImpl` fake (a `vi.fn` that resolves a hand-built
 * `Response` with no actual socket involved) — solid for verifying request
 * shape and business logic, but it can't catch anything specific to a real
 * HTTP round trip: actual TCP connect, real header/status-line parsing,
 * real chunked/streamed response bodies, or a real in-flight request being
 * aborted by `AbortController` (as opposed to a fake `Promise` that just
 * never resolves).
 *
 * This sandbox has no route to the real `github.com`, so this suite can't
 * validate the real `cli-latest` release asset. What it *can* do — and
 * couldn't before — is stand up a real `node:http` server on localhost and
 * drive the update engine's real `fetch`-based code paths against it end to
 * end, by handing each function a `fetchImpl` that performs a genuine
 * socket round trip (Node's real global `fetch`) against that local server
 * rather than returning an in-memory `Response`. That closes the specific
 * gap called out in `task-summary/P4-4.3-cli-self-update.md`'s "Known
 * limitations" — every network-facing code path here (`fetchLatestVersion`,
 * `downloadAndVerify`, and `applyUpdate`'s standalone-binary path) now has
 * at least one test that goes over a real socket, including a genuine
 * timeout/abort against a request that is actually in flight.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyUpdate } from "./applyUpdate.js";
import { downloadAndVerify } from "./downloadAndVerify.js";
import { fetchLatestVersion } from "./fetchLatestVersion.js";

const REPO = "falcon-dev/falcon";
const ASSET_NAME = "falcon-darwin-arm64";
const BINARY_PAYLOAD = Buffer.from("totally-real-binary-bytes-for-the-integration-test");
const BINARY_DIGEST = createHash("sha256").update(BINARY_PAYLOAD).digest("hex");

type RouteHandler = (respond: (status: number, body: string | Buffer, delayMs?: number) => void) => void;

describe("update engine — real localhost HTTP round trip", () => {
  let server: Server;
  let baseOrigin: string;
  const routes = new Map<string, RouteHandler>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const handler = req.url ? routes.get(req.url) : undefined;
      const respond = (status: number, body: string | Buffer, delayMs = 0) => {
        const send = () => {
          res.writeHead(status);
          res.end(body);
        };
        if (delayMs > 0) setTimeout(send, delayMs);
        else send();
      };
      if (!handler) {
        respond(404, "not found");
        return;
      }
      handler(respond);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterEach(() => {
    routes.clear();
  });

  /**
   * `fetchLatestVersion`/`downloadAndVerify` always build their request URL
   * against `https://github.com/...` (`config.ts`'s `releaseAssetUrl` has no
   * override — there's no reason for production code to make GitHub's own
   * hostname configurable). This test-only `fetchImpl` performs a real
   * `fetch()` call — a genuine socket, real HTTP parsing, a real
   * `AbortController` wired to a real in-flight request — it just retargets
   * the *host* of that request to this test's local server, keeping the
   * path (and therefore the route-matching + asset-name logic under test)
   * exactly as production built it.
   */
  function localFetch(): typeof fetch {
    return ((url: string, init?: RequestInit) => {
      const target = new URL(new URL(url).pathname, baseOrigin);
      return fetch(target, init);
    }) as typeof fetch;
  }

  it("fetchLatestVersion: reads the VERSION body over a real socket", async () => {
    routes.set(`/${REPO}/releases/download/cli-latest/VERSION`, (respond) => respond(200, "9.9.9\n"));

    await expect(fetchLatestVersion({ repo: REPO, fetchImpl: localFetch() })).resolves.toBe("9.9.9");
  });

  it("fetchLatestVersion: a real HTTP 404 (not a hand-built Response) resolves to null", async () => {
    // No route registered for VERSION — the server's own real 404 path answers.
    await expect(fetchLatestVersion({ repo: REPO, fetchImpl: localFetch() })).resolves.toBeNull();
  });

  it("fetchLatestVersion: aborts a genuinely in-flight request on timeout", async () => {
    routes.set(`/${REPO}/releases/download/cli-latest/VERSION`, (respond) => respond(200, "9.9.9\n", 200));

    await expect(
      fetchLatestVersion({ repo: REPO, fetchImpl: localFetch(), timeoutMs: 20 }),
    ).resolves.toBeNull();
  });

  it("downloadAndVerify: downloads bytes + sidecar and verifies the checksum over real sockets", async () => {
    routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}`, (respond) =>
      respond(200, BINARY_PAYLOAD),
    );
    routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}.sha256`, (respond) =>
      respond(200, `${BINARY_DIGEST}  ${ASSET_NAME}\n`),
    );

    const bytes = await downloadAndVerify({ repo: REPO, assetName: ASSET_NAME, fetchImpl: localFetch() });
    expect(bytes.equals(BINARY_PAYLOAD)).toBe(true);
  });

  it("downloadAndVerify: a real checksum mismatch over the wire is rejected", async () => {
    routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}`, (respond) =>
      respond(200, BINARY_PAYLOAD),
    );
    routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}.sha256`, (respond) =>
      respond(200, `${"0".repeat(64)}  ${ASSET_NAME}\n`),
    );

    await expect(
      downloadAndVerify({ repo: REPO, assetName: ASSET_NAME, fetchImpl: localFetch() }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  describe("applyUpdate — standalone-binary path, end to end over a real socket", () => {
    let dir: string;
    let execPath: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "falcon-live-apply-update-"));
      execPath = path.join(dir, "falcon");
      await writeFile(execPath, "old binary contents");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("downloads, verifies, and atomically replaces execPath via a real HTTP round trip", async () => {
      routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}`, (respond) =>
        respond(200, BINARY_PAYLOAD),
      );
      routes.set(`/${REPO}/releases/download/cli-latest/${ASSET_NAME}.sha256`, (respond) =>
        respond(200, `${BINARY_DIGEST}  ${ASSET_NAME}\n`),
      );

      const result = await applyUpdate({
        installKind: "standalone-binary",
        repo: REPO,
        version: "9.9.9",
        execPath,
        fetchImpl: localFetch(),
        platform: "darwin",
        arch: "arm64",
      });

      expect(result).toEqual({ applied: true, installKind: "standalone-binary" });
      expect((await readFile(execPath)).equals(BINARY_PAYLOAD)).toBe(true);
      const stats = await stat(execPath);
      expect(stats.mode % 0o1000).toBe(0o755);
    });
  });
});
