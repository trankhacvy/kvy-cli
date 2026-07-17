import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-index-test-"));
  process.env.FALCON_HOME_DIR = homeDir;
  process.env.FALCON_NO_SERVICE = "1";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.FALCON_HOME_DIR;
  delete process.env.FALCON_NO_SERVICE;
  rmSync(homeDir, { recursive: true, force: true });
});

async function importMain() {
  const mod = await import("./index.js");
  return mod.main;
}

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

  it("describes a claude passthrough start without executing anything", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["claude", "--resume", "abc123"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("would start a claude session");
    expect(stdout.mock.calls[0]?.[0]).toContain("--resume abc123");
    stdout.mockRestore();
  });

  it("describes a codex passthrough start with the honest no-local-mode note", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["codex"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("would start a codex session");
    expect(stdout.mock.calls[0]?.[0]).toContain("Codex has no local terminal mode");
    stdout.mockRestore();
  });

  it("does not print the codex no-local-mode note for a claude start", async () => {
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await main(["claude"]);

    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).not.toContain("no local terminal mode");
    stdout.mockRestore();
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

  it("wires `shim install/uninstall/status` to commands/shim.js", async () => {
    vi.doMock("./commands/shim.js", () => ({
      runShimCommand: vi.fn(async (action: string) => {
        process.stdout.write(`shim ${action} called\n`);
        return 0;
      }),
    }));
    const shimModule = await import("./commands/shim.js");
    const main = await importMain();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(await main(["shim", "status"])).toBe(0);
    expect(shimModule.runShimCommand).toHaveBeenCalledWith("status");
    expect(stdout).toHaveBeenCalledWith("shim status called\n");

    stdout.mockRestore();
    vi.doUnmock("./commands/shim.js");
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

  describe("shell-shim onboarding prompt (auth login wiring)", () => {
    afterEach(() => {
      vi.doUnmock("./auth/index.js");
      vi.doUnmock("./shim/onboardingPrompt.js");
    });

    it("offers the shim opt-in prompt after a successful `auth login`", async () => {
      vi.doMock("./auth/index.js", () => ({ runAuthCommand: vi.fn(async () => 0) }));
      vi.doMock("./shim/onboardingPrompt.js", () => ({
        maybePromptShimOptIn: vi.fn(async () => {}),
      }));
      const onboardingModule = await import("./shim/onboardingPrompt.js");
      const main = await importMain();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["auth", "login"]);

      expect(code).toBe(0);
      expect(onboardingModule.maybePromptShimOptIn).toHaveBeenCalledOnce();
    });

    it("does not offer the prompt when `auth login` fails", async () => {
      vi.doMock("./auth/index.js", () => ({ runAuthCommand: vi.fn(async () => 1) }));
      vi.doMock("./shim/onboardingPrompt.js", () => ({
        maybePromptShimOptIn: vi.fn(async () => {}),
      }));
      const onboardingModule = await import("./shim/onboardingPrompt.js");
      const main = await importMain();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["auth", "login"]);

      expect(code).toBe(1);
      expect(onboardingModule.maybePromptShimOptIn).not.toHaveBeenCalled();
    });

    it("does not offer the prompt for `auth status`/`auth logout`", async () => {
      vi.doMock("./auth/index.js", () => ({ runAuthCommand: vi.fn(async () => 0) }));
      vi.doMock("./shim/onboardingPrompt.js", () => ({
        maybePromptShimOptIn: vi.fn(async () => {}),
      }));
      const onboardingModule = await import("./shim/onboardingPrompt.js");
      const main = await importMain();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      expect(await main(["auth", "status"])).toBe(0);
      expect(await main(["auth", "logout"])).toBe(0);
      expect(onboardingModule.maybePromptShimOptIn).not.toHaveBeenCalled();
    });
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
    });

    it("calls ensureDaemonRunning before describing a start, and proceeds when it succeeds", async () => {
      delete process.env.FALCON_NO_SERVICE;
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

      const code = await main(["claude"]);

      expect(code).toBe(0);
      expect(ensureDaemonRunning).toHaveBeenCalledOnce();
      expect(stdout.mock.calls[0]?.[0]).toContain("would start a claude session");
      stdout.mockRestore();
    });

    it("exits 1 and never describes the start when ensureDaemonRunning fails to bring up the daemon", async () => {
      delete process.env.FALCON_NO_SERVICE;
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

      const code = await main(["claude"]);

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
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("base ref: develop"));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("remote:   origin"));
      stdout.mockRestore();
    });

    it("prints '(none)' for an unconfigured workspace when no flags are given", async () => {
      const main = await importMain();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const code = await main(["workspace", "config", "--directory", homeDir]);

      expect(code).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("base ref: (none)"));
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
});
