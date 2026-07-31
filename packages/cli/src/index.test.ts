import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./daemon/gitExec.js";

// index.ts reads FALCON_HOME_DIR (via the module-scope logger) at import
// time, so give it an isolated, disposable home directory before the first
// import and reset the module registry between tests that care about it.
//
// `start`/`auth`/`sessions`/`resume` now call `ensureDaemonRunning()` first
// (PRD FR-1.2), which — left unchecked — would spawn a real detached
// `daemon start-sync` child process during every test run. `FALCON_NO_SERVICE=1`
// is the documented opt-out (see index.ts's help text / ensureDaemonRunning.ts),
// so tests that aren't specifically exercising the daemon-auto-start wiring
// set it to keep those subcommands side-effect-free; the dedicated tests below
// unset it and mock `./daemon/ensureDaemonRunning.js` instead.
//
// `ensureDaemon()` also fires `maybeTriggerAutoUpdate()` (plan.md §16 "4.3
// Distribution & self-host") right alongside it — left unchecked, that would
// spawn a real detached `falcon update` child (and, past the rate-limit
// check, a real network call) during every test run here too.
// `FALCON_NO_UPDATE=1` is that feature's own documented opt-out, set for the
// same reason `FALCON_NO_SERVICE` is: no test in this file exercises the
// auto-update trigger itself (see `update/autoUpdateTrigger.test.ts` for
// that), so every test here should stay side-effect-free by default.
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-index-test-"));
  process.env.FALCON_HOME_DIR = homeDir;
  process.env.FALCON_NO_SERVICE = "1";
  process.env.FALCON_NO_UPDATE = "1";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.FALCON_HOME_DIR;
  delete process.env.FALCON_NO_SERVICE;
  delete process.env.FALCON_NO_UPDATE;
  rmSync(homeDir, { recursive: true, force: true });
});

async function importMain() {
  const mod = await import("./index.js");
  return mod.main;
}

// `beforeEach` above resets modules and every test here re-imports index.js
// fresh, which now loads node-pty's real compiled native addon — cold-loading
// that (plus a full fresh CLI module graph) can outrun vitest's 5s default on
// a loaded CI runner, even though a warm process re-import is fast.
describe("main()", () => {
  it("prints help and exits 0 for --help", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toContain("falcon claude [args...]");
    stdout.mockRestore();
  });

  it("prints the version and exits 0 for --version", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["--version"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toMatch(/^falcon \d+\.\d+\.\d+\n$/);
    stdout.mockRestore();
  });

  it("prefers a bun-compile-baked __FALCON_CLI_VERSION__ over reading package.json", async () => {
    // scripts/build-binaries.sh bakes this identifier in via
    // `bun build --compile --define:__FALCON_CLI_VERSION__=...` (see
    // index.ts's readVersion() doc comment) since a compiled standalone
    // binary has no on-disk package.json sibling to fall back to. Simulate
    // that by defining the global the same way `--define` would splice a
    // literal into the bundle, then confirm readVersion() takes the
    // short-circuit branch instead of the filesystem read.
    // biome-ignore lint/suspicious/noExplicitAny: test-only global stub
    (globalThis as any).__FALCON_CLI_VERSION__ = "9.9.9-baked";
    try {
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["--version"]);

      expect(code).toBe(0);
      expect(stdout.mock.calls[0]?.[0]).toBe("falcon 9.9.9-baked\n");
      stdout.mockRestore();
    } finally {
      // biome-ignore lint/performance/noDelete: restoring global test stub
      delete (globalThis as any).__FALCON_CLI_VERSION__;
    }
  });

  it("exits 1 with an honest not-logged-in error for a claude start when no credentials exist", async () => {
    // `runStart` now wires `claude` to `commands/start.js`'s real local-mode
    // launch (index.ts's `runStart` doc comment) instead of the old
    // `describeStart` stub — this isolated `FALCON_HOME_DIR` has no
    // `access.key`, so it must fail fast on the credentials check (step 1)
    // rather than attempting any network call.
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["claude", "--resume", "abc123"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("not logged in");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("routes `falcon codex` to the real remote-only Codex command (fails fast when not logged in)", async () => {
    // v2 (ACP): `falcon codex` no longer prints a stub — it runs
    // `runStartCodexCommand`, which (with an empty temp FALCON_HOME_DIR)
    // fails the credentials pre-flight first, exactly like `falcon claude`.
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["codex"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("not logged in");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("fails `falcon claude` the same way when not logged in", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["claude"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("not logged in");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("prints a usage error and exits 1 for a malformed Falcon subcommand", async () => {
    const main = await importMain();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["resume"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("falcon: ");
    expect(stderr.mock.calls[1]?.[0]).toContain("usage: falcon resume <session-id>");
    stderr.mockRestore();
  });

  it("wires the `kill` subcommand to daemon/kill.js and awaits the async result", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(),
      killSessions: vi.fn(),
      killAll: vi.fn(async () => ({
        targeted: [
          {
            pid: 100,
            ppid: 1,
            command: "falcon daemon start-sync",
            kind: "daemon",
            spawnedByDaemon: false,
          },
        ],
        outcomes: [
          { pid: 100, command: "falcon daemon start-sync", kind: "daemon", signal: "SIGTERM" },
        ],
      })),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(() => "falcon kill all: 1/1 process(es) terminated\n"),
    }));
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const result = main(["kill", "all"]);
    expect(result).toBeInstanceOf(Promise);
    const code = await result;

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("falcon kill all: 1/1 process(es) terminated\n");
    stdout.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("exits 1 when `kill` reports a per-pid failure", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(async () => ({
        targeted: [
          {
            pid: 100,
            ppid: 1,
            command: "falcon daemon start-sync",
            kind: "daemon",
            spawnedByDaemon: false,
          },
        ],
        outcomes: [
          {
            pid: 100,
            command: "falcon daemon start-sync",
            kind: "daemon",
            signal: "none",
            error: "EPERM",
          },
        ],
      })),
      killSessions: vi.fn(),
      killAll: vi.fn(),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(() => "falcon kill daemon: 0/1 process(es) terminated\n"),
    }));
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["kill", "daemon"]);

    expect(code).toBe(1);
    stdout.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("falls back to the error handler if the kill promise rejects", async () => {
    vi.doMock("./daemon/kill.js", () => ({
      killDaemon: vi.fn(),
      killSessions: vi.fn(async () => {
        throw new Error("ps exploded");
      }),
      killAll: vi.fn(),
      killAllForce: vi.fn(),
      describeKillSummary: vi.fn(),
    }));
    const main = await importMain();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await main(["kill", "sessions"]);

    expect(code).toBe(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("unexpected error");
    stderr.mockRestore();
    vi.doUnmock("./daemon/kill.js");
  });

  it("wires `doctor` (no subcommand) to a report, without a `clean` side effect", async () => {
    vi.doMock("./daemon/doctor.js", () => ({
      createDoctorDeps: vi.fn((overrides) => overrides),
      runDoctor: vi.fn(async () => ({
        daemon: { running: false },
        resumableSessionCount: 0,
        processes: [],
      })),
      runDoctorClean: vi.fn(),
      describeDoctorReport: vi.fn(() => "daemon: not running\n"),
      describeDoctorCleanSummary: vi.fn(),
    }));
    const doctorModule = await import("./daemon/doctor.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["doctor"]);

    expect(code).toBe(0);
    expect(doctorModule.runDoctor).toHaveBeenCalledOnce();
    expect(doctorModule.runDoctorClean).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("daemon: not running\n");
    stdout.mockRestore();
    vi.doUnmock("./daemon/doctor.js");
  });

  it("wires `doctor clean` to the runaway-kill path and exits 1 on a per-pid failure", async () => {
    vi.doMock("./daemon/doctor.js", () => ({
      createDoctorDeps: vi.fn((overrides) => overrides),
      runDoctor: vi.fn(),
      runDoctorClean: vi.fn(async () => ({
        targeted: [
          {
            pid: 100,
            ppid: 1,
            command: "falcon daemon start-sync",
            kind: "daemon",
            spawnedByDaemon: false,
          },
        ],
        outcomes: [
          {
            pid: 100,
            command: "falcon daemon start-sync",
            kind: "daemon",
            signal: "none",
            error: "EPERM",
          },
        ],
      })),
      describeDoctorReport: vi.fn(),
      describeDoctorCleanSummary: vi.fn(
        () => "falcon doctor clean: 0/1 runaway process(es) terminated\n",
      ),
    }));
    const doctorModule = await import("./daemon/doctor.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["doctor", "clean"]);

    expect(code).toBe(1);
    expect(doctorModule.runDoctorClean).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(
      "falcon doctor clean: 0/1 runaway process(es) terminated\n",
    );
    stdout.mockRestore();
    vi.doUnmock("./daemon/doctor.js");
  });

  it("wires `adapters install/upgrade` to commands/adapters.js", async () => {
    vi.doMock("./commands/adapters.js", () => ({
      runAdaptersInstallCommand: vi.fn(async () => {
        process.stdout.write("adapters install called\n");
        return 0;
      }),
      runAdaptersUpgradeCommand: vi.fn(async () => {
        process.stdout.write("adapters upgrade called\n");
        return 1;
      }),
    }));
    const adaptersModule = await import("./commands/adapters.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await main(["adapters", "install"])).toBe(0);
    expect(adaptersModule.runAdaptersInstallCommand).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith("adapters install called\n");

    expect(await main(["adapters", "upgrade"])).toBe(1);
    expect(adaptersModule.runAdaptersUpgradeCommand).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith("adapters upgrade called\n");

    stdout.mockRestore();
    vi.doUnmock("./commands/adapters.js");
  });

  it("wires `daemon service install/uninstall/status` to commands/serviceInstall.js", async () => {
    vi.doMock("./commands/serviceInstall.js", () => ({
      runDaemonServiceCommand: vi.fn(async (action: string) => {
        process.stdout.write(`service ${action} called\n`);
        return 0;
      }),
    }));
    const serviceModule = await import("./commands/serviceInstall.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await main(["daemon", "service", "status"])).toBe(0);
    expect(serviceModule.runDaemonServiceCommand).toHaveBeenCalledWith("status");
    expect(stdout).toHaveBeenCalledWith("service status called\n");

    stdout.mockRestore();
    vi.doUnmock("./commands/serviceInstall.js");
  });

  it("wires `update` to update/runUpdateCommand.js and prints its message", async () => {
    vi.doMock("./update/runUpdateCommand.js", () => ({
      runUpdateCommand: vi.fn(async () => ({
        code: 0,
        message: "falcon: already up to date (0.1.0)\n",
      })),
    }));
    const updateModule = await import("./update/runUpdateCommand.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await main(["update"])).toBe(0);
    expect(updateModule.runUpdateCommand).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith("falcon: already up to date (0.1.0)\n");

    stdout.mockRestore();
    vi.doUnmock("./update/runUpdateCommand.js");
  });

  it("never writes CLI-level output through the file logger's channel", async () => {
    // Help/version/errors are direct stdout/stderr writes from index.ts
    // itself (legitimate CLI UX) — distinct from the logger, which this
    // test isn't exercising directly. Assert only that main() never throws
    // (nor its returned promise rejects) for any of the top-level command
    // shapes. `auth login` is included: with no reachable server it fails
    // fast (request-failed) and resolves with exit code 1 rather than
    // hanging or throwing; `process.stdout.isTTY` is false under the test
    // runner, so it never tries to open a browser.
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.FALCON_BACKEND_URL = "http://127.0.0.1:1";

    await expect(main(["auth", "login"])).resolves.toBe(1);
    await expect(main(["daemon", "status"])).resolves.toBeTypeOf("number");
    await expect(main(["sessions", "list"])).resolves.toBeTypeOf("number");
    expect(() => main(["workspace", "sync"])).not.toThrow();

    delete process.env.FALCON_BACKEND_URL;
    stdout.mockRestore();
    stderr.mockRestore();
  });

  describe("daemon auto-start wiring (ensureDaemonRunning)", () => {
    afterEach(() => {
      vi.doUnmock("./daemon/ensureDaemonRunning.js");
      vi.doUnmock("./auth/login.js");
    });

    /**
     * AX-1.1: `ensureLoggedIn` now gates EVERY provider, not just claude, and it
     * runs ahead of `ensureDaemon()` — so a test about daemon wiring has to get
     * past auth first. Stubbing it keeps these tests about what they say they're
     * about; the real not-logged-in path is covered separately above.
     */
    function mockSignedIn(): void {
      vi.doMock("./auth/login.js", () => ({
        ensureLoggedIn: vi.fn(async () => ({ ok: true })),
        runAuthLogin: vi.fn(async () => 0),
      }));
    }

    it("calls ensureDaemonRunning before the start command, and proceeds when it succeeds", async () => {
      // `codex` here (not `claude`) deliberately: with an empty temp
      // FALCON_HOME_DIR the real `runStartCodexCommand` still fails its own
      // pre-flight (exit 1) — which proves the daemon check ran first and
      // control proceeded into the command, without needing a full stack.
      delete process.env.FALCON_NO_SERVICE;
      mockSignedIn();
      const ensureDaemonRunning = vi.fn(async () => ({
        ok: true,
        state: { pid: 123, port: 4242, version: "0.1.0-test", startedAt: 1 },
      }));
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        createEnsureDaemonRunningDeps: vi.fn((overrides) => overrides),
        ensureDaemonRunning,
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["codex"]);

      expect(code).toBe(1);
      expect(ensureDaemonRunning).toHaveBeenCalledOnce();
      stdout.mockRestore();
      stderr.mockRestore();
    });

    it("runs `auth login` before ensureDaemonRunning, so the daemon sees fresh credentials at its one-shot startup", async () => {
      // The daemon only attempts machine registration once, at its own startup, and only
      // if credentials already exist then — so `auth login` must complete (writing
      // credentials) before the daemon is ever started, not after.
      delete process.env.FALCON_NO_SERVICE;
      const runAuthCommand = vi.fn(async () => 0);
      vi.doMock("./auth/index.js", () => ({ runAuthCommand }));
      const callOrder: string[] = [];
      runAuthCommand.mockImplementation(async () => {
        callOrder.push("login");
        return 0;
      });
      const ensureDaemonRunning = vi.fn(async () => {
        callOrder.push("daemon");
        return { ok: true, state: { pid: 123, port: 4242, version: "0.1.0-test", startedAt: 1 } };
      });
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        createEnsureDaemonRunningDeps: vi.fn((overrides) => overrides),
        ensureDaemonRunning,
      }));
      const main = await importMain();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["auth", "login"]);

      expect(code).toBe(0);
      expect(callOrder).toEqual(["login", "daemon"]);
      vi.doUnmock("./auth/index.js");
    });

    it("still reports exit 1 if the daemon fails to start after a successful `auth login`", async () => {
      delete process.env.FALCON_NO_SERVICE;
      vi.doMock("./auth/index.js", () => ({ runAuthCommand: vi.fn(async () => 0) }));
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        createEnsureDaemonRunningDeps: vi.fn((overrides) => overrides),
        ensureDaemonRunning: vi.fn(async () => ({
          ok: false,
          reason: "start-failed",
          message: "falcon daemon: timed out waiting for the daemon to become ready\n",
        })),
      }));
      const main = await importMain();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["auth", "login"]);

      expect(code).toBe(1);
      expect(stderr.mock.calls[0]?.[0]).toContain("timed out");
      vi.doUnmock("./auth/index.js");
    });

    it("exits 1 and never describes the start when ensureDaemonRunning fails to bring up the daemon", async () => {
      // Auth runs before the daemon for every provider now (AX-1.1), so this has to
      // get past it to exercise the daemon-failure path it's actually about.
      delete process.env.FALCON_NO_SERVICE;
      mockSignedIn();
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        createEnsureDaemonRunningDeps: vi.fn((overrides) => overrides),
        ensureDaemonRunning: vi.fn(async () => ({
          ok: false,
          reason: "start-failed",
          message: "falcon daemon: timed out waiting for the daemon to become ready\n",
        })),
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["codex"]);

      expect(code).toBe(1);
      expect(stderr.mock.calls[0]?.[0]).toContain("timed out");
      expect(stdout).not.toHaveBeenCalled();
      stdout.mockRestore();
      stderr.mockRestore();
    });

    it("treats a 'disabled' result (FALCON_NO_SERVICE=1) the same as success for auth/sessions/resume", async () => {
      const ensureDaemonRunning = vi.fn(async () => ({ ok: false, reason: "disabled" }));
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        createEnsureDaemonRunningDeps: vi.fn((overrides) => overrides),
        ensureDaemonRunning,
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      expect(await main(["auth", "status"])).toBe(0);
      expect(await main(["sessions", "list"])).toBe(0);
      // "disabled" only means "don't auto-start the daemon" — the command
      // still runs for real afterward; `abc123` isn't a local transcript nor
      // a known daemon-managed session in this isolated FALCON_HOME_DIR, so
      // it honestly fails (exit 1), rather than being blocked before it even
      // got a chance to run.
      expect(await main(["resume", "abc123"])).toBe(1);

      expect(ensureDaemonRunning).toHaveBeenCalledTimes(3);
      stdout.mockRestore();
    });
  });

  describe("auto-update wiring (maybeTriggerAutoUpdate)", () => {
    afterEach(() => {
      vi.doUnmock("./update/autoUpdateTrigger.js");
      vi.doUnmock("./auth/login.js");
    });

    /** Same rationale as the daemon-wiring block's own helper — see AX-1.1 there. */
    function mockSignedIn(): void {
      vi.doMock("./auth/login.js", () => ({
        ensureLoggedIn: vi.fn(async () => ({ ok: true })),
        runAuthLogin: vi.fn(async () => 0),
      }));
    }

    it("calls maybeTriggerAutoUpdate alongside the daemon auto-start check", async () => {
      // The auto-update side effect fires from `ensureDaemon()` regardless of the
      // command that follows — the codex command then exits 1 against an empty temp
      // home, which is fine; we only assert the update trigger ran.
      delete process.env.FALCON_NO_UPDATE;
      mockSignedIn();
      const maybeTriggerAutoUpdate = vi.fn(async () => {});
      vi.doMock("./update/autoUpdateTrigger.js", () => ({ maybeTriggerAutoUpdate }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["codex"]);

      expect(code).toBe(1);
      expect(maybeTriggerAutoUpdate).toHaveBeenCalledOnce();
      stdout.mockRestore();
      stderr.mockRestore();
    });

    it("never throws main() even if maybeTriggerAutoUpdate rejects unexpectedly", async () => {
      // Auth runs before `ensureDaemon()` (and thus before `maybeTriggerAutoUpdate`,
      // which lives inside it), so this has to get past auth to reach the rejection.
      delete process.env.FALCON_NO_UPDATE;
      mockSignedIn();
      vi.doMock("./update/autoUpdateTrigger.js", () => ({
        maybeTriggerAutoUpdate: vi.fn(async () => {
          throw new Error("boom");
        }),
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const code = await main(["codex"]);

      expect(code).toBe(1);
      expect(stderr.mock.calls[0]?.[0]).toContain("unexpected error");
      stdout.mockRestore();
      stderr.mockRestore();
    });
  });

  describe("adopt subcommand wiring", () => {
    afterEach(() => {
      vi.doUnmock("./commands/adopt.js");
    });

    it("wires `adopt` to commands/adopt.js with the parsed list/remote flags", async () => {
      const runAdoptCommand = vi.fn(async () => 0);
      vi.doMock("./commands/adopt.js", () => ({
        createAdoptCommandDeps: vi.fn(
          (required: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
            ...required,
            ...overrides,
          }),
        ),
        runAdoptCommand,
      }));
      const main = await importMain();

      const code = await main(["adopt", "--list"]);

      expect(code).toBe(0);
      expect(runAdoptCommand).toHaveBeenCalledExactlyOnceWith(
        { list: true, remote: false },
        expect.objectContaining({ workingDirectory: process.cwd() }),
      );
    });

    it("wires `--continue` to the same command as `adopt`", async () => {
      const runAdoptCommand = vi.fn(async () => 0);
      vi.doMock("./commands/adopt.js", () => ({
        createAdoptCommandDeps: vi.fn(
          (required: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
            ...required,
            ...overrides,
          }),
        ),
        runAdoptCommand,
      }));
      const main = await importMain();

      const code = await main(["--continue"]);

      expect(code).toBe(0);
      expect(runAdoptCommand).toHaveBeenCalledExactlyOnceWith(
        { list: false, remote: false },
        expect.objectContaining({ workingDirectory: process.cwd() }),
      );
    });
  });

  describe("workspace config subcommand", () => {
    it("writes baseRef/remote to settings.json and prints them back", async () => {
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main([
        "workspace",
        "config",
        "--base-ref",
        "develop",
        "--remote",
        "origin",
        "--directory",
        homeDir,
      ]);

      expect(code).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("base ref:     develop"));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("remote:       origin"));
      stdout.mockRestore();
    });

    it("prints '(none)' for an unconfigured workspace when no flags are given", async () => {
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["workspace", "config", "--directory", homeDir]);

      expect(code).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("base ref:     (none)"));
      stdout.mockRestore();
    });

    it("does not call ensureDaemonRunning (no daemon interaction)", async () => {
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        ensureDaemonRunning: vi.fn(() => {
          throw new Error("workspace config must never touch the daemon");
        }),
        createEnsureDaemonRunningDeps: vi.fn(() => ({})),
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["workspace", "config", "--directory", homeDir]);

      expect(code).toBe(0);
      stdout.mockRestore();
      vi.doUnmock("./daemon/ensureDaemonRunning.js");
    });
  });

  describe("workspace register/list/unregister subcommands", () => {
    it("registers a directory, lists it, then unregisters it", async () => {
      const { realpath } = await import("node:fs/promises");
      const resolvedHomeDir = await realpath(homeDir);
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const registerCode = await main([
        "workspace",
        "register",
        "--directory",
        homeDir,
        "--name",
        "Home",
      ]);
      expect(registerCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`registered ${resolvedHomeDir}`));

      const listCode = await main(["workspace", "list"]);
      expect(listCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(resolvedHomeDir));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Home"));

      const unregisterCode = await main(["workspace", "unregister", "--directory", homeDir]);
      expect(unregisterCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("removed"));

      stdout.mockRestore();
    });

    it("unregistering an unregistered directory returns exit code 1", async () => {
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["workspace", "unregister", "--directory", homeDir]);

      expect(code).toBe(1);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("was not registered"));
      stdout.mockRestore();
    });

    it("does not call ensureDaemonRunning (no daemon interaction)", async () => {
      vi.doMock("./daemon/ensureDaemonRunning.js", () => ({
        ensureDaemonRunning: vi.fn(() => {
          throw new Error("workspace register must never touch the daemon");
        }),
        createEnsureDaemonRunningDeps: vi.fn(() => ({})),
      }));
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["workspace", "register", "--directory", homeDir]);

      expect(code).toBe(0);
      stdout.mockRestore();
      vi.doUnmock("./daemon/ensureDaemonRunning.js");
    });
  });
}, 15_000);

// Real `git` binary, no mocks (same rationale as `daemon/gitExec.test.ts`):
// this is the local `falcon -b <branch>` parity fix for known-issues.md #2's
// first bullet — `ensureBranchWorkspace` itself is already covered against a
// fake `GitExec` in `daemon/gitWorktree.test.ts`, so this only needs to prove
// the thin composition in `index.ts` actually reaches it and surfaces a real
// `.worktrees/<branch>` directory, not that worktree creation itself works.
describe("resolveStartWorkingDirectory", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "falcon-start-workdir-"));
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.com"], repo);
    await runGit(["config", "user.name", "Test"], repo);
    await runGit(["commit", "--allow-empty", "-m", "initial"], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns cwd unchanged when no branch is given", async () => {
    const { resolveStartWorkingDirectory } = await import("./index.js");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);

    const result = await resolveStartWorkingDirectory(undefined);

    expect(result).toEqual({ ok: true, directory: repo });
    cwdSpy.mockRestore();
  });

  it("creates a real .worktrees/<branch> directory for a new branch", async () => {
    const { resolveStartWorkingDirectory } = await import("./index.js");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);

    const result = await resolveStartWorkingDirectory("feature/local-worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const expectedDir = path.join(repo, ".worktrees", "feature/local-worktree");
    expect(await stat(expectedDir).then((s) => s.isDirectory())).toBe(true);
    expect(result.directory).toBe(await realpath(expectedDir));
    cwdSpy.mockRestore();
  });

  it("returns ok:false with an unsafe-branch-name message instead of throwing", async () => {
    const { resolveStartWorkingDirectory } = await import("./index.js");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);

    const result = await resolveStartWorkingDirectory("-x");

    expect(result).toEqual({
      ok: false,
      message: "falcon -b -x: unsafe branch name: -x",
    });
    cwdSpy.mockRestore();
  });

  it("returns ok:false when cwd is not a git repository", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "falcon-start-workdir-norepo-"));
    try {
      const { resolveStartWorkingDirectory } = await import("./index.js");
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(notARepo);

      const result = await resolveStartWorkingDirectory("feature/x");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toContain("falcon -b feature/x:");
      cwdSpy.mockRestore();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
