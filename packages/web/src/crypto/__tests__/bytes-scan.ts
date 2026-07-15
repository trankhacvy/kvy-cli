/**
 * Recursively scans an arbitrary value for a byte sequence — used by the
 * trust-boundary test to assert that no message posted back to the main
 * thread contains the raw master secret / DEK anywhere inside it, at any
 * nesting depth, not just as a top-level field.
 */
function bytesInclude(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

export function containsSecretBytes(value: unknown, secret: Uint8Array, seen = new Set<unknown>()): boolean {
  if (value == null) {
    return false;
  }
  if (value instanceof Uint8Array) {
    return bytesInclude(value, secret);
  }
  if (value instanceof ArrayBuffer) {
    return bytesInclude(new Uint8Array(value), secret);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretBytes(item, secret, seen));
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsSecretBytes(item, secret, seen),
  );
}
