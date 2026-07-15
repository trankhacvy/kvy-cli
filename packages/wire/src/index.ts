/**
 * @falcon/wire — the single source of truth every Falcon package imports
 * for the wire protocol: `cli` for encrypt/relay, `server` for validation +
 * Drizzle JSON typing, `web` for the reducer.
 *
 * Wire contracts only. Additive-only forever — the server can never migrate
 * ciphertext (falcon-system-design.md §5.3). A field is never removed or
 * retyped, only added; deprecation means ignore-on-read. This is enforced
 * by the schema-shape compat test in `src/__tests__/`.
 */
export * from "./box";
export * from "./permissions";
export * from "./reserved";
export * from "./rows";
export * from "./rpc";
export * from "./session";
export * from "./updates";
