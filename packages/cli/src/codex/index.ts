/**
 * Codex provider barrel. The hand-rolled `codex app-server` JSON-RPC client,
 * its envelope mapper, and its permission handler were removed in the v2 ACP
 * migration (plan.md §17 Phase 2.3): Codex now runs through the shared
 * `acp/acpRemote.ts` transport driving the official `codex-acp` adapter, with
 * exec/patch approvals arriving via ACP's standard
 * `session/request_permission` → `acp/acpPermissionHandler.ts`. What remains
 * here is provider detection + the honest no-local-TUI note, still used by
 * `daemon/doctor.ts` and `index.ts`.
 */
export {
  CODEX_NO_LOCAL_MODE_NOTE,
  CODEX_NOT_INSTALLED_MESSAGE,
  codexProvider,
  type DetectCodexOptions,
  detectCodex,
  type ProviderDetectionResult,
} from "./codexProviderAdapter.js";
