import { notFound } from "next/navigation";
// import { MirrorViewScreen } from "@/features/unmanaged-sessions";

// This protected static-export route (next.config.ts) prerenders every route at build time — same
// constraint `/dashboard/session/[id]/page.tsx` documents. Real unmanaged-session ids
// come from the sync engine's `unmanagedSessions` snapshot (a separate,
// not-yet-wired data layer, see `MirrorViewScreen`'s doc comment); until
// that lands there's exactly one prerenderable id, `demo`, and every other
// id is reached via client-side navigation from `UnmanagedSection`.
//
// Route disabled (not deleted): `UnmanagedSection` is currently unwired from
// the Home screen (`session-list-screen.tsx`'s doc comment — a `kvy
// claude` session can show up as a false-positive duplicate of its own
// managed card), so this is the only remaining entry point and it's turned
// off too rather than left dangling. Re-enable by restoring the
// `MirrorViewScreen` import and swapping it back in below.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function UnmanagedMirrorPage({ params }: { params: Promise<{ id: string }> }) {
  await params;
  notFound();
}
