import { SessionTimelineScreen } from "@/components/timeline/SessionTimelineScreen";

// Static export prerenders every route at build time — `generateStaticParams` needs at
// least one concrete id to emit this route's HTML/JS shell; `demo` is a placeholder.
// `SessionTimelineScreen` reads the real session id from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionTimelineScreen sessionId={id} />;
}
