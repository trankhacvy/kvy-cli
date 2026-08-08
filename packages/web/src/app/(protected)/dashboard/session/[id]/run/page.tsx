import { SessionRunClient } from "./session-run-client";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/dashboard/session/[id]/git/page.tsx`) — `generateStaticParams` just
// needs one concrete id to emit this route's HTML/JS shell; `demo` is an
// arbitrary placeholder. This server shell never reads its own (permanently
// `demo`-baked) `params` prop — `SessionRunClient` reads the real id from the
// URL client-side via `useParams()`.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default function SessionRunPage() {
  return <SessionRunClient />;
}
