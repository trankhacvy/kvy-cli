import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPersistedSessions,
  type PersistedSession,
  persistSession,
  readPersistedSessions,
  removePersistedSession,
  sessionsFilePath,
} from "./sessionsStore.js";

// Captured once at module-load time (not per `fixture()` call, and not
// hardcoded to an arbitrary past instant) so every fixture in this file
// shares one exact timestamp — both to keep `toEqual` comparisons stable
// and to stay safely inside `readPersistedSessions`'s real 14-day expiry
// window relative to whenever this suite actually runs.
const FIXED_SAVED_AT = Date.now();

function fixture(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    sessionId: "sess_1",
    provider: "claude-code",
    encryption: { encryptionKey: "wrapped-dek", seq: 1, metadataVersion: 1, agentStateVersion: 1 },
    savedAt: FIXED_SAVED_AT,
    ...overrides,
  };
}

describe("sessionsStore", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-sessions-store-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns {} when no sessions.json exists yet", async () => {
    expect(await readPersistedSessions(homeDir)).toEqual({});
  });

  it("round-trips a persisted session", async () => {
    const session = fixture();
    await persistSession(homeDir, session);

    expect(await readPersistedSessions(homeDir)).toEqual({ sess_1: session });
  });

  it("upserts without clobbering a different session's record", async () => {
    await persistSession(homeDir, fixture({ sessionId: "sess_1" }));
    await persistSession(homeDir, fixture({ sessionId: "sess_2" }));

    const all = await readPersistedSessions(homeDir);
    expect(Object.keys(all).sort()).toEqual(["sess_1", "sess_2"]);
  });

  it("serializes concurrent persistSession calls without losing either write", async () => {
    await Promise.all([
      persistSession(homeDir, fixture({ sessionId: "sess_a" })),
      persistSession(homeDir, fixture({ sessionId: "sess_b" })),
      persistSession(homeDir, fixture({ sessionId: "sess_c" })),
    ]);

    const all = await readPersistedSessions(homeDir);
    expect(Object.keys(all).sort()).toEqual(["sess_a", "sess_b", "sess_c"]);
  });

  it("drops entries older than the 14-day expiry window", async () => {
    const now = Date.now();
    const stale = fixture({ sessionId: "sess_old", savedAt: now - 15 * 24 * 60 * 60 * 1000 });
    const fresh = fixture({ sessionId: "sess_new", savedAt: now });
    await persistSession(homeDir, stale);
    await persistSession(homeDir, fresh);

    const all = await readPersistedSessions(homeDir, () => now);
    expect(Object.keys(all)).toEqual(["sess_new"]);
  });

  it("treats a corrupt sessions.json as empty", async () => {
    await writeFile(sessionsFilePath(homeDir), "{not valid json", "utf8");
    expect(await readPersistedSessions(homeDir)).toEqual({});
  });

  it("drops a well-formed-JSON-but-wrong-shape entry while keeping valid siblings", async () => {
    await writeFile(
      sessionsFilePath(homeDir),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          sess_bad: { sessionId: "sess_bad" }, // missing `encryption`/`savedAt`
          sess_good: fixture({ sessionId: "sess_good" }),
        },
      }),
      "utf8",
    );

    expect(await readPersistedSessions(homeDir)).toEqual({
      sess_good: fixture({ sessionId: "sess_good" }),
    });
  });

  it("round-trips the optional directory field (Flow 3 — spawn-directory-dedup)", async () => {
    const session = fixture({ directory: "/Users/vy/projects/falcon" });
    await persistSession(homeDir, session);

    expect((await readPersistedSessions(homeDir)).sess_1?.directory).toBe(
      "/Users/vy/projects/falcon",
    );
  });

  it("loads a pre-v2 schemaVersion:1 record with no `directory` key as `directory === undefined` (backward compat)", async () => {
    // Hand-written to look exactly like a `sessions.json` a prior daemon
    // version wrote — schemaVersion 1, and a record with no `directory` key
    // at all. The `directory` field is purely additive, so this must still
    // load without throwing or dropping the entry.
    await writeFile(
      sessionsFilePath(homeDir),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          sess_legacy: {
            sessionId: "sess_legacy",
            provider: "claude-code",
            encryption: {
              encryptionKey: "wrapped-dek",
              seq: 7,
              metadataVersion: 2,
              agentStateVersion: 3,
            },
            savedAt: FIXED_SAVED_AT,
          },
        },
      }),
      "utf8",
    );

    const all = await readPersistedSessions(homeDir);
    const legacy = all.sess_legacy;
    expect(legacy).toBeDefined();
    expect(legacy?.directory).toBeUndefined();
    // No data loss on the other fields.
    expect(legacy).toEqual({
      sessionId: "sess_legacy",
      provider: "claude-code",
      encryption: { encryptionKey: "wrapped-dek", seq: 7, metadataVersion: 2, agentStateVersion: 3 },
      savedAt: FIXED_SAVED_AT,
    });
  });

  it("removePersistedSession deletes only the named entry", async () => {
    await persistSession(homeDir, fixture({ sessionId: "sess_1" }));
    await persistSession(homeDir, fixture({ sessionId: "sess_2" }));

    await removePersistedSession(homeDir, "sess_1");

    expect(await readPersistedSessions(homeDir)).toEqual({
      sess_2: fixture({ sessionId: "sess_2" }),
    });
  });

  it("removePersistedSession is a no-op for an id that isn't present", async () => {
    await persistSession(homeDir, fixture({ sessionId: "sess_1" }));
    await expect(removePersistedSession(homeDir, "does-not-exist")).resolves.toBeUndefined();
    expect(await readPersistedSessions(homeDir)).toEqual({ sess_1: fixture() });
  });

  it("clearPersistedSessions deletes the whole file and is safe to call twice", async () => {
    await persistSession(homeDir, fixture());
    await clearPersistedSessions(homeDir);
    expect(await readPersistedSessions(homeDir)).toEqual({});
    await expect(clearPersistedSessions(homeDir)).resolves.toBeUndefined();
    await expect(readFile(sessionsFilePath(homeDir), "utf8")).rejects.toThrow();
  });
});
