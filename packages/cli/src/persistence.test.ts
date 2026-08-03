import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  readCredentials,
  readSettings,
  SUPPORTED_SETTINGS_SCHEMA_VERSION,
  updateSettings,
  writeCredentials,
} from "./persistence.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-persistence-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("readSettings", () => {
  it("returns defaults when settings.json doesn't exist", async () => {
    const settings = await readSettings({ homeDir });
    expect(settings).toEqual({
      schemaVersion: SUPPORTED_SETTINGS_SCHEMA_VERSION,
      onboardingCompleted: false,
    });
  });

  it("returns defaults when settings.json is corrupt JSON", async () => {
    writeFileSync(path.join(homeDir, "settings.json"), "{not json");
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(false);
  });

  it("returns defaults when settings.json is a JSON array, not an object", async () => {
    writeFileSync(path.join(homeDir, "settings.json"), "[1,2,3]");
    const settings = await readSettings({ homeDir });
    expect(settings).toEqual({
      schemaVersion: SUPPORTED_SETTINGS_SCHEMA_VERSION,
      onboardingCompleted: false,
    });
  });

  it("reads back known fields and ignores unknown ones", async () => {
    writeFileSync(
      path.join(homeDir, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        onboardingCompleted: true,
        machineId: "m-123",
        backendUrl: "https://api.example.com",
        somethingFromTheFuture: "ignored",
      }),
    );
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(true);
    expect(settings.machineId).toBe("m-123");
    expect(settings.backendUrl).toBe("https://api.example.com");
    expect(settings).not.toHaveProperty("somethingFromTheFuture");
  });

  it("normalizes adoptedSessions, dropping any entry whose value isn't a string array", async () => {
    writeFileSync(
      path.join(homeDir, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        onboardingCompleted: false,
        adoptedSessions: {
          "old-1": ["old-1", "new-1"],
          "old-2": "not-an-array",
          "old-3": ["ok", 42],
        },
      }),
    );
    const settings = await readSettings({ homeDir });
    expect(settings.adoptedSessions).toEqual({ "old-1": ["old-1", "new-1"] });
  });

  it("normalizes sleepInhibit, ignoring any value outside the tri-state", async () => {
    writeFileSync(
      path.join(homeDir, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        onboardingCompleted: false,
        sleepInhibit: "always",
      }),
    );
    const settings = await readSettings({ homeDir });
    expect(settings.sleepInhibit).toBe("always");
  });

  it("drops an unknown sleepInhibit value rather than throwing", async () => {
    writeFileSync(
      path.join(homeDir, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        onboardingCompleted: false,
        sleepInhibit: "forever",
      }),
    );
    const settings = await readSettings({ homeDir });
    expect(settings.sleepInhibit).toBeUndefined();
  });
});

describe("updateSettings", () => {
  it("creates settings.json with the updater's result and the current schema version", async () => {
    const updated = await updateSettings((current) => ({ ...current, onboardingCompleted: true }), {
      homeDir,
    });

    expect(updated.onboardingCompleted).toBe(true);
    expect(updated.schemaVersion).toBe(SUPPORTED_SETTINGS_SCHEMA_VERSION);

    const onDisk = JSON.parse(readFileSync(path.join(homeDir, "settings.json"), "utf8"));
    expect(onDisk.onboardingCompleted).toBe(true);
  });

  it("persists across successive updates", async () => {
    await updateSettings((current) => ({ ...current, machineId: "m-1" }), { homeDir });
    const second = await updateSettings((current) => ({ ...current, onboardingCompleted: true }), {
      homeDir,
    });

    expect(second.machineId).toBe("m-1");
    expect(second.onboardingCompleted).toBe(true);
  });

  it("leaves no .lock or .tmp file behind after a successful update", async () => {
    await updateSettings((current) => current, { homeDir });
    expect(() => statSync(path.join(homeDir, "settings.json.lock"))).toThrow();
    expect(() => statSync(path.join(homeDir, "settings.json.tmp"))).toThrow();
  });

  it("reclaims a stale lock file left by a dead process", async () => {
    // Simulate a crashed prior holder: a lock file with an old mtime.
    const lockFile = path.join(homeDir, "settings.json.lock");
    writeFileSync(lockFile, "");
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockFile, staleTime, staleTime);

    const updated = await updateSettings((current) => ({ ...current, onboardingCompleted: true }), {
      homeDir,
    });
    expect(updated.onboardingCompleted).toBe(true);
  });

  it("serializes truly concurrent updaters so no increment is lost", async () => {
    // Fire N concurrent read-modify-write cycles from within the same
    // process. If the lock didn't serialize them, two updaters could both
    // read the same `counter` value and one increment would be clobbered.
    const concurrency = 20;
    await updateSettings((current) => ({ ...current, machineId: "0" }), { homeDir });

    await Promise.all(
      Array.from({ length: concurrency }, () =>
        updateSettings(
          (current) => {
            const next = Number(current.machineId ?? "0") + 1;
            return { ...current, machineId: String(next) };
          },
          { homeDir },
        ),
      ),
    );

    const final = await readSettings({ homeDir });
    expect(final.machineId).toBe(String(concurrency));
  });

  it("round-trips a valid sleepInhibit mode through updateSettings", async () => {
    const updated = await updateSettings((current) => ({ ...current, sleepInhibit: "onPower" }), {
      homeDir,
    });
    expect(updated.sleepInhibit).toBe("onPower");

    const reread = await readSettings({ homeDir });
    expect(reread.sleepInhibit).toBe("onPower");
  });
});

describe("credentials (access.key)", () => {
  it("returns null when access.key doesn't exist", async () => {
    expect(await readCredentials({ homeDir })).toBeNull();
  });

  it("returns null when access.key is corrupt JSON", async () => {
    writeFileSync(path.join(homeDir, "access.key"), "{not json");
    expect(await readCredentials({ homeDir })).toBeNull();
  });

  it("returns null when access.key is missing required fields", async () => {
    writeFileSync(path.join(homeDir, "access.key"), JSON.stringify({ token: "t" }));
    expect(await readCredentials({ homeDir })).toBeNull();
  });

  it("round-trips valid credentials", async () => {
    await writeCredentials({ token: "tok-123", masterSecret: "c2VjcmV0" }, { homeDir });
    const read = await readCredentials({ homeDir });
    expect(read).toEqual({ token: "tok-123", masterSecret: "c2VjcmV0" });
  });

  it("writes access.key with 0600 permissions", async () => {
    await writeCredentials({ token: "tok-123", masterSecret: "c2VjcmV0" }, { homeDir });
    const mode = statSync(path.join(homeDir, "access.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-locks permissions down to 0600 even if a looser file already existed", async () => {
    const file = path.join(homeDir, "access.key");
    writeFileSync(file, JSON.stringify({ token: "old", masterSecret: "b2xk" }));
    chmodSync(file, 0o644);

    await writeCredentials({ token: "new", masterSecret: "bmV3" }, { homeDir });

    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "new", masterSecret: "bmV3" });
  });

  it("clearCredentials removes access.key and is a no-op if already absent", async () => {
    await writeCredentials({ token: "tok-123", masterSecret: "c2VjcmV0" }, { homeDir });
    await clearCredentials({ homeDir });
    expect(await readCredentials({ homeDir })).toBeNull();

    // Second call with nothing to remove must not throw.
    await expect(clearCredentials({ homeDir })).resolves.toBeUndefined();
  });
});
