import { MirrorViewScreen } from "@/features/unmanaged-sessions";

// This protected static-export route (next.config.ts) prerenders every route at build time — same
// constraint `/dashboard/session/[id]/page.tsx` documents. Real unmanaged-session ids
// come from the sync engine's `unmanagedSessions` snapshot (a separate,
// not-yet-wired data layer, see `MirrorViewScreen`'s doc comment); until
// that lands there's exactly one prerenderable id, `demo`, and every other
// id is reached via client-side navigation from `UnmanagedSection` (the
// already-booted SPA shell renders this page's component for any id without
// needing a matching prerendered HTML file — the same precedent
// `features/new-session`'s post-spawn `Open session` link relies on).
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function UnmanagedMirrorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MirrorViewScreen id={id} />;
}
