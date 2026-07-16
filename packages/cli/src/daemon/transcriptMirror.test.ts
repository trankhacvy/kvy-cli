import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdoptMirrorParams } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectPath } from "../claude/scanner.js";
import type { ResolvedProviderSession } from "./providerSessionResolver.js";
import { findChunkEnd, handleAdoptMirror, type TranscriptMirrorDeps } from "./transcriptMirror.js";

describe("findChunkEnd", () => {
  it("cuts at the requested budget when it lands exactly on a newline", () => {
    const buf = Buffer.from("aaa\nbbb\nccc\nddd\n", "utf8");
    expect(findChunkEnd(buf, 0, 8)).toBe(8); // "aaa\nbbb\n"
  });

  it("pulls the cut back to the nearest preceding newline instead of splitting a line", () => {
    const buf = Buffer.from("aaa\nbbb\nccc\n", "utf8");
    // Budget of 6 lands mid "bbb\n" (index 4..7) — must pull back to index 4.
    expect(findChunkEnd(buf, 0, 6)).toBe(4);
  });

  it("never splits a multi-byte UTF-8 character across a chunk boundary", () => {
    const line1 = "hello\n";
    const line2 = "emoji: \u{1F600}\n"; // 4-byte UTF-8 codepoint
    const buf = Buffer.from(line1 + line2, "utf8");
    // Budget lands inside the emoji's byte sequence if cut naively.
    const cut = findChunkEnd(buf, 0, line1.length + 3);
    const chunk = buf.subarray(0, cut).toString("utf8");
    expect(chunk).toBe(line1); // pulled back to the newline, not mid-emoji
    expect(Buffer.byteLength(chunk, "utf8")).toBe(cut);
  });

  it("returns the full remaining length when the budget covers the rest of the file", () => {
    const buf = Buffer.from("short\n", "utf8");
    expect(findChunkEnd(buf, 0, 1000)).toBe(buf.length);
  });

  it("falls back to a hard byte cut when a single line exceeds the whole budget", () => {
    const buf = Buffer.from(`${"x".repeat(20)}\nrest`, "utf8");
    expect(findChunkEnd(buf, 0, 10)).toBe(10);
  });
});

describe("handleAdoptMirror", () => {
  let baseDir: string;
  let claudeConfigDir: string;
  let workspacePath: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;
  let resolved: ResolvedProviderSession;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    baseDir = join(tmpdir(), `transcript-mirror-test-${unique}`);
    claudeConfigDir = join(baseDir, "claude-home");
    workspacePath = join(baseDir, "project");
    env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    projectDir = getProjectPath(workspacePath, env);
    await mkdir(projectDir, { recursive: true });
    resolved = { workspaceId: "ws_1", directory: workspacePath };
  });

  afterEach(async () => {
    if (existsSync(baseDir)) await rm(baseDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<TranscriptMirrorDeps> = {}): TranscriptMirrorDeps {
    return {
      resolveProviderSession: async () => resolved,
      env,
      ...overrides,
    };
  }

  function params(overrides: Partial<AdoptMirrorParams> = {}): AdoptMirrorParams {
    return { idempotencyKey: "idem_1", providerSessionId: "prov_1", ...overrides };
  }

  it("throws when the provider session can't be resolved", async () => {
    await expect(
      handleAdoptMirror(params(), deps({ resolveProviderSession: async () => null })),
    ).rejects.toThrow(/could not resolve/);
  });

  it("throws when the transcript file can't be read", async () => {
    await expect(handleAdoptMirror(params(), deps())).rejects.toThrow(/failed to read transcript/);
  });

  it("returns the whole transcript in one done chunk when it's small", async () => {
    await writeFile(join(projectDir, "prov_1.jsonl"), "line one\nline two\n");

    const result = await handleAdoptMirror(params(), deps());

    expect(result).toEqual({ chunk: "line one\nline two\n", nextCursor: null, done: true });
  });

  it("paginates a transcript larger than maxBytes across successive cursors, reassembling it exactly", async () => {
    const contents = `${"a".repeat(20)}\n${"b".repeat(20)}\n${"c".repeat(20)}\n`;
    await writeFile(join(projectDir, "prov_1.jsonl"), contents);

    let reassembled = "";
    let cursor: number | undefined;
    let chunkCount = 0;
    for (;;) {
      const result = await handleAdoptMirror(params({ maxBytes: 25, cursor }), deps());
      reassembled += result.chunk;
      chunkCount++;
      if (result.done) break;
      cursor = result.nextCursor ?? undefined;
    }

    expect(reassembled).toBe(contents);
    expect(chunkCount).toBeGreaterThan(1); // actually exercised pagination, not a single chunk
  });

  it("clamps a chunk to at most 64KB even if maxBytes asks for more", async () => {
    const bigLine = `${"x".repeat(200_000)}\n`;
    await writeFile(join(projectDir, "prov_1.jsonl"), bigLine);

    const result = await handleAdoptMirror(params({ maxBytes: 1_000_000 }), deps());

    expect(Buffer.byteLength(result.chunk, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.done).toBe(false);
  });

  it("throws when cursor is past the end of the transcript", async () => {
    await writeFile(join(projectDir, "prov_1.jsonl"), "short\n");
    await expect(handleAdoptMirror(params({ cursor: 1000 }), deps())).rejects.toThrow(
      /past the end/,
    );
  });

  it("returns an empty done chunk for an empty transcript file", async () => {
    await writeFile(join(projectDir, "prov_1.jsonl"), "");
    const result = await handleAdoptMirror(params(), deps());
    expect(result).toEqual({ chunk: "", nextCursor: null, done: true });
  });
});
