import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-logger-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function readLogLines(dir: string): unknown[] {
  const logsDir = path.join(dir, "logs");
  const [file] = readdirSync(logsDir);
  if (!file) return [];
  const contents = readFileSync(path.join(logsDir, file), "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("createLogger", () => {
  it("never writes to stdout or stderr", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const logger = createLogger({ homeDir, debug: true });
    logger.debug("debug line");
    logger.info("info line");
    logger.warn("warn line");
    logger.error("error line");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes structured lines to a dated file under <home>/logs", () => {
    const logger = createLogger({ homeDir, debug: true });
    logger.info("hello", { foo: "bar" });

    const lines = readLogLines(homeDir) as Array<{
      level: string;
      message: string;
      meta?: Record<string, unknown>;
      time: string;
    }>;

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.message).toBe("hello");
    expect(lines[0]?.meta).toEqual({ foo: "bar" });
    expect(typeof lines[0]?.time).toBe("string");
  });

  it("suppresses debug lines by default (no FALCON_DEBUG)", () => {
    const logger = createLogger({ homeDir, env: {} });
    logger.debug("should be suppressed");
    logger.info("should be kept");

    const lines = readLogLines(homeDir) as Array<{ message: string }>;
    expect(lines.map((l) => l.message)).toEqual(["should be kept"]);
  });

  it("includes debug lines when FALCON_DEBUG=1", () => {
    const logger = createLogger({ homeDir, env: { FALCON_DEBUG: "1" } });
    logger.debug("should be kept");

    const lines = readLogLines(homeDir) as Array<{ message: string }>;
    expect(lines.map((l) => l.message)).toEqual(["should be kept"]);
  });

  it("includes debug lines when the debug option is explicitly true", () => {
    const logger = createLogger({ homeDir, debug: true, env: {} });
    logger.debug("should be kept");

    const lines = readLogLines(homeDir) as Array<{ message: string }>;
    expect(lines.map((l) => l.message)).toEqual(["should be kept"]);
  });

  it("omits the meta field entirely when not provided", () => {
    const logger = createLogger({ homeDir });
    logger.info("no meta here");

    const lines = readLogLines(homeDir) as Array<Record<string, unknown>>;
    expect(lines[0]).not.toHaveProperty("meta");
  });
});
