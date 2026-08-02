/**
 * `${VAR}` expansion for env-var templates in spawn params.
 *
 * Deliberately fail-fast: an unresolved variable name fails the whole spawn
 * rather than silently substituting `''`.
 */

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type ExpandEnvVarsResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; unresolved: string[] };

/**
 * Expands every `${VAR}` placeholder in `template`'s values against
 * `baseEnv`. Collects every unresolved variable name across all entries (not
 * just the first) so a caller can report the complete list in one error
 * rather than making the operator fix-and-retry one typo at a time.
 */
export function expandEnvVars(
  template: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv,
): ExpandEnvVarsResult {
  const unresolved = new Set<string>();
  const expanded: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(template)) {
    expanded[key] = rawValue.replace(VAR_PATTERN, (whole: string, varName: string) => {
      const value = baseEnv[varName];
      if (value === undefined) {
        unresolved.add(varName);
        return whole;
      }
      return value;
    });
  }

  if (unresolved.size > 0) {
    return { ok: false, unresolved: [...unresolved].sort() };
  }
  return { ok: true, env: expanded };
}
