/**
 * Reserved wire namespaces for deferred features (kvy-system-design.md
 * §14 "Deferred-Feature Hooks"; kvy-prd.md §6.4). No schemas exist for
 * these yet — this file exists only to reserve the `t`/method prefixes so a
 * future feature can never collide with (or be confused for) an
 * already-shipped literal.
 *
 * - `checkpoint:*` — workspace sync / checkpoint restore
 *   (`kvy workspace sync|load`; `Workspace.syncEnabled`/`sandboxConfig`
 *   columns already exist, unused).
 * - `preview:*`    — live preview STREAMING (push updates) for spawned dev
 *   servers/tunnels — still reserved and unused. The request/response
 *   `preview.*` RPC schemas (ports/tunnels/open/close) now live in
 *   `preview.ts` (docs/features/dev-server-preview.md) — that's a separate,
 *   already-shipped namespace (machine RPC method names, not this
 *   ephemeral-channel `t` prefix); this reservation is only for the
 *   still-deferred live-status push channel a future Phase 2 would add.
 * - `voice:*`      — voice input/output session events.
 *
 * When one of these ships: add its schema in its own file, export it from
 * `index.ts`, and update this comment — never repurpose an existing `t`
 * literal for it (additive-only-forever policy, design §5.3).
 */
export {};
