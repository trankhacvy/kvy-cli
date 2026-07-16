import { SessionListScreen } from "@/features/session-list";

// The Home screen (design §9.2 "Home" row, falcon-prd.md FR-7.1). Backed by
// a mock data source for now — the sync engine (`src/sync/engine.ts`) is
// landed on `main` but not yet wired into this screen; see
// `SessionListScreen`'s doc comment for the injectable seam that swaps in
// the real hook later. Auth pages exist under /signin, /auth, /pair, and
// /settings/recovery, but this route isn't auth-gated yet, so it's reachable
// unauthenticated for now — both are tracked as still [planned] in
// CLAUDE.md.
export default function Home() {
  return <SessionListScreen />;
}
