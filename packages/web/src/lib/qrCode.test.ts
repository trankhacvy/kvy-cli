import { describe, expect, it } from "vitest";
import { encodeQrMatrix, qrMatrixToPath } from "./qrCode";

describe("encodeQrMatrix", () => {
  it("returns a square grid matching the reported size", () => {
    const { size, modules } = encodeQrMatrix("https://kvy.example/session/abc123/");
    expect(size).toBeGreaterThan(0);
    expect(modules).toHaveLength(size);
    for (const row of modules) {
      expect(row).toHaveLength(size);
    }
  });

  it("always sets the three finder-pattern corners (top-left, top-right, bottom-left) dark", () => {
    // Every QR symbol at every version/EC level has a 7x7 finder pattern
    // pinned to these three corners — a solid outer border is the one
    // structural invariant safe to assert without re-implementing a decoder.
    const { size, modules } = encodeQrMatrix("https://kvy.example/session/abc123/");
    const topLeft = modules[0]?.[0];
    const topRight = modules[0]?.[size - 1];
    const bottomLeft = modules[size - 1]?.[0];
    expect(topLeft).toBe(true);
    expect(topRight).toBe(true);
    expect(bottomLeft).toBe(true);
  });

  it("produces a different (non-trivial) matrix for different input text", () => {
    const a = encodeQrMatrix("https://kvy.example/session/aaaaaaaa/");
    const b = encodeQrMatrix("https://kvy.example/session/bbbbbbbb/");
    expect(a.modules).not.toEqual(b.modules);
  });

  it("is deterministic for the same input", () => {
    const first = encodeQrMatrix("https://kvy.example/session/abc123/");
    const second = encodeQrMatrix("https://kvy.example/session/abc123/");
    expect(first).toEqual(second);
  });

  it("grows to fit a longer payload", () => {
    const short = encodeQrMatrix("https://f.example/s/1/");
    const long = encodeQrMatrix(`https://kvy.example/session/${"a".repeat(200)}/`);
    expect(long.size).toBeGreaterThan(short.size);
  });
});

describe("qrMatrixToPath", () => {
  it("emits one 'move + unit box' subpath per dark module", () => {
    const path = qrMatrixToPath({
      size: 2,
      modules: [
        [true, false],
        [false, true],
      ],
    });
    expect(path).toBe("M0 0h1v1h-1ZM1 1h1v1h-1Z");
  });

  it("returns an empty string for an all-light matrix", () => {
    const path = qrMatrixToPath({
      size: 2,
      modules: [
        [false, false],
        [false, false],
      ],
    });
    expect(path).toBe("");
  });

  it("matches the module count of a real encoded matrix", () => {
    const matrix = encodeQrMatrix("https://kvy.example/session/abc123/");
    const path = qrMatrixToPath(matrix);
    const darkCount = matrix.modules.flat().filter(Boolean).length;
    // Each dark module contributes exactly one "M...Z" subpath.
    expect(path.split("M").length - 1).toBe(darkCount);
  });
});
