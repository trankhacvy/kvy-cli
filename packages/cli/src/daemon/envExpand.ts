/**
 * `${VAR}` expansion for env-var templates handed to a daemon-spawned
 * session process (plan.md §16 "3.1 Remote spawn": "env `${VAR}` expansion
 * fail-fast").
 *
 * Deliberately NOT the Bash/Node convention of silently substituting `''`
 * for an unset variable: a spawned session silently missing, say, its API
 * base URL because of a typo'd variable name is exactly the kind of
 * surprising, hard-to-diagnose failure the design's "no silent failures"
 * principle forbids. A template referencing an unresolved variable fails
 * the whole spawn instead.
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
