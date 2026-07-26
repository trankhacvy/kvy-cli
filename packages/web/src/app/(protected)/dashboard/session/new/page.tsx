import { NewSessionScreen } from "@/features/new-session";

// The New Session flow (design §9.2 "New session" row, falcon-prd.md
// FR-7.5/UC5): machine → directory picker → provider/mode/model → spawn.
// The screen now always renders live data (`NewSessionScreen`'s
// `useLiveNewSessionMachines`/`useLiveNewSessionActions`, gated on the
// chosen machine's unwrapped DEK) — see its doc comment for the injectable
// seams a test can still swap the mocks back into.
export default function NewSessionPage() {
  return <NewSessionScreen />;
}
