import { SessionFilesScreen } from "@/features/repo-files";

// Static export prerenders every route at build time — `generateStaticParams` needs at
// least one concrete id to emit this route's HTML/JS shell; `demo` is a placeholder.
// `SessionFilesScreen` reads the real session id from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionFilesScreen sessionId={id} />;
}
