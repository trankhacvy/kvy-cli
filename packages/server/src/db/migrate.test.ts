import path from "node:path";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrateMock = vi.fn(async () => {});
const drizzleMock = vi.fn((client: unknown) => client);
const postgresMock = vi.fn();

vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: migrateMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));
vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("../config.js", () => ({
  env: { DATABASE_URL: "postgres://falcon:falcon@localhost:5432/falcon" },
}));

/**
 * Every operation `runMigrations()` issues is a tagged-template call
 * (`client\`...\``). Route each on the SQL text it contains rather than call
 * order, so the fake doesn't have to reproduce the real sequencing.
 */
function createFakeClient(migrationCount: string, lockedAlways = true): postgres.Sql {
  const end = vi.fn(async () => {});
  const fn = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("pg_try_advisory_lock")) return [{ locked: lockedAlways }];
    if (text.includes("pg_advisory_unlock")) return [];
    if (text.includes("__drizzle_migrations")) return [{ count: migrationCount }];
    return [];
  });
  return Object.assign(fn, { end }) as unknown as postgres.Sql;
}

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

describe("journalEntryCount", () => {
  it("reads the real shipped drizzle/meta/_journal.json and returns 9", async () => {
    const { journalEntryCount } = await import("./migrate.js");
    await expect(journalEntryCount(migrationsFolder)).resolves.toBe(9);
  });
});

describe("acquireLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false, not throw, not hang, when pg_try_advisory_lock keeps answering false", async () => {
    const { acquireLock } = await import("./migrate.js");
    const client = createFakeClient("9", false);

    const result = acquireLock(client);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(false);
  });

  it("returns true immediately when the lock is free", async () => {
    const { acquireLock } = await import("./migrate.js");
    const client = createFakeClient("9", true);

    await expect(acquireLock(client)).resolves.toBe(true);
  });
});

describe("runMigrations", () => {
  beforeEach(() => {
    vi.resetModules();
    migrateMock.mockClear();
    drizzleMock.mockClear();
    postgresMock.mockReset();
  });

  it("throws when the post-migrate applied count is below the journal count", async () => {
    postgresMock.mockReturnValue(createFakeClient("6"));
    const { runMigrations } = await import("./migrate.js");

    await expect(runMigrations()).rejects.toThrow(/expected 9 applied migrations, found 6/);
  });

  it("resolves when the post-migrate applied count matches the journal count", async () => {
    postgresMock.mockReturnValue(createFakeClient("9"));
    const { runMigrations } = await import("./migrate.js");

    await expect(runMigrations()).resolves.toBeUndefined();
    expect(migrateMock).toHaveBeenCalledOnce();
  });

  it("always releases the connection, even on the mismatch throw", async () => {
    const client = createFakeClient("6");
    postgresMock.mockReturnValue(client);
    const { runMigrations } = await import("./migrate.js");

    await expect(runMigrations()).rejects.toThrow();
    expect((client as unknown as { end: () => Promise<void> }).end).toHaveBeenCalledOnce();
  });
});
