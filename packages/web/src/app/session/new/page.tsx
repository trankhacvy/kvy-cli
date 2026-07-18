import { RequireAuth } from "@/features/auth";
import { NewSessionScreen } from "@/features/new-session";

// The New Session flow (design §9.2 "New session" row, falcon-prd.md
// FR-7.5/UC5): machine → directory picker → provider/mode/model → spawn.
// Backed by a mock data source for now — same not-yet-wired-to-the-sync-
// engine state as `/` (`SessionListScreen`) and `/session/[id]`
// (`SessionTimelineScreen`); see `NewSessionScreen`'s doc comment for the
// injectable seams that swap in the real machine list + machine RPC client
// later.
export default function NewSessionPage() {
  return (
    <RequireAuth>
      <NewSessionScreen />
    </RequireAuth>
  );
}
