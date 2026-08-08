import { SessionGitClient } from "./session-git-client";

// Static export prerenders every route at build time — `generateStaticParams` needs at
// least one concrete id to emit this route's HTML/JS shell; `demo` is a placeholder.
// This server shell never reads its own (permanently `demo`-baked) `params` prop —
// `SessionGitClient` reads the real id from the URL client-side via `useParams()`.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default function SessionGitPage() {
  return <SessionGitClient />;
}
