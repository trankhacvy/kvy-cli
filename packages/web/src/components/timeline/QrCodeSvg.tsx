import { encodeQrMatrix, qrMatrixToPath } from "@/lib/qrCode";

/** Modules of whitespace padded around the code on every side — the QR
 * spec's own recommended "quiet zone" minimum, without which some phone
 * camera scanners fail to lock onto the symbol at all. */
const QUIET_ZONE = 2;

/**
 * Renders `value` as a scannable QR code for the "Continue on mobile" handoff.
 * Deliberately fixed black-on-white
 * regardless of the app's own dark/light theme (`use-theme.ts`) — a QR
 * code's contrast is functional, not decorative, and inverting or
 * theme-tinting it risks a real phone camera failing to decode it.
 */
export function QrCodeSvg({ value, className }: { value: string; className?: string }) {
  const matrix = encodeQrMatrix(value);
  const path = qrMatrixToPath(matrix);
  const viewSize = matrix.size + QUIET_ZONE * 2;

  return (
    <svg
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      role="img"
      aria-label="QR code: scan to continue this session on mobile"
      className={className}
    >
      <rect width={viewSize} height={viewSize} fill="#fff" />
      <path d={path} fill="#000" transform={`translate(${QUIET_ZONE}, ${QUIET_ZONE})`} />
    </svg>
  );
}
