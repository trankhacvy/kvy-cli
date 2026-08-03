/**
 * QR-code mobile handoff: "Continue on
 * mobile — Scan to open this session" plus a copy-link button on every
 * session. This module is the pure, synchronous encode step —
 * `qrcode`'s `create()` (the same isomorphic core both its Node and browser
 * builds share, per the package's own `browser` field mapping) runs the QR
 * symbol algorithm with no canvas/DOM/fs dependency at all, so it's callable
 * from a plain render function on either side. `QrCodeSvg.tsx` turns the
 * returned matrix into a real `<path>` SVG element itself (via
 * `qrMatrixToPath` below) — same "compile to real elements, never
 * `dangerouslySetInnerHTML`" rule `markdown.ts`/`diffHighlight.ts` already
 * follow, extended here to a generated image rather than syntax-highlighted
 * text.
 */
import { create } from "qrcode";

/** A QR code's rendered form: a square `size x size` grid of booleans (`true`
 * = a dark module). Deliberately not the library's own `BitMatrix` (a class
 * with a `get(row, col)` accessor) so callers — and this module's own
 * tests — can work with a plain, structurally-comparable value. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

/**
 * Encodes `text` as a QR code and returns its module grid. Uses error
 * correction level `M` (~15% recovery) — a reasonable choice for "scan a
 * session-handoff link off a screen", and a reasonable default between `L`
 * (denser, less tolerant of a glare/reflection on a phone camera) and `H`
 * (unnecessarily large for a plain URL payload).
 */
export function encodeQrMatrix(text: string): QrMatrix {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const size = modules.size;
  const grid: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) {
      line.push(modules.get(row, col) === 1);
    }
    grid.push(line);
  }
  return { size, modules: grid };
}

/**
 * Renders a `QrMatrix` as a single SVG `<path>` `d` string — one dark
 * module becomes a 1x1 "move, draw box" subpath (`M{x} {y}h1v1h-1Z`), all
 * concatenated so the whole code paints as one shape with one fill, instead
 * of one `<rect>` per module (a plain QR code can have 1000+ dark modules
 * at higher versions). Coordinates are in module units — the caller scales
 * the whole path via the containing `<svg>`'s `viewBox`.
 */
export function qrMatrixToPath({ size, modules }: QrMatrix): string {
  const segments: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row]?.[col]) {
        segments.push(`M${col} ${row}h1v1h-1Z`);
      }
    }
  }
  return segments.join("");
}
