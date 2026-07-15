/**
 * Reserved wire namespaces for deferred features (falcon-system-design.md
 * §14 "Deferred-Feature Hooks"; falcon-prd.md §6.4). No schemas exist for
 * these yet — this file exists only to reserve the `t`/method prefixes so a
 * future feature can never collide with (or be confused for) an
 * already-shipped literal.
 *
 * - `checkpoint:*` — workspace sync / checkpoint restore
 *   (`falcon workspace sync|load`; `Workspace.syncEnabled`/`sandboxConfig`
 *   columns already exist, unused).
 * - `preview:*`    — live preview streaming for spawned dev servers.
 * - `voice:*`      — voice input/output session events.
 *
 * When one of these ships: add its schema in its own file, export it from
 * `index.ts`, and update this comment — never repurpose an existing `t`
 * literal for it (additive-only-forever policy, design §5.3).
 */
export {};
