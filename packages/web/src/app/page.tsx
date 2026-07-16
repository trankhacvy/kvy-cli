import { SessionListScreen } from "@/features/session-list";

// The Home screen (design §9.2 "Home" row, falcon-prd.md FR-7.1). Backed by
// a mock data source for now — `apiSocket`/the sync engine aren't landed on
// `main` yet (plan.md 1.6); see `SessionListScreen`'s doc comment for the
// injectable seam that swaps in the real one later. Auth is not wired up
// yet, so this route is reachable unauthenticated for now.
export default function Home() {
  return <SessionListScreen />;
}
