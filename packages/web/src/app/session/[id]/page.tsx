import { SessionTimelineScreen } from "@/components/timeline/SessionTimelineScreen";

// Static export (next.config.ts) prerenders every route at build time — no
// server ever renders user content (design §5.3). Real session ids come
// from the sync engine (plan.md §8.1, a separate in-flight task); until
// that lands there's exactly one prerenderable id, `demo`, which serves the
// fixture timeline in `components/timeline/demo-items.ts`.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionTimelineScreen sessionId={id} />;
}
