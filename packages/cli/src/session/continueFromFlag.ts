export function extractContinueFromFlag(args: string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--continue-from") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        found = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--continue-from=")) {
      found = arg.slice("--continue-from=".length);
    }
  }
  return found;
}
