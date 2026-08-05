import Link from "next/link";
import { KvyMark } from "@/components/kvy-mark";

const AUTH_ART_URL = "/auth-art.webp";

export function AuthArtPanel({ caption }: { caption: string }) {
  return (
    <aside className="relative hidden w-[55%] lg:block">
      <div className="absolute inset-0 overflow-hidden rounded-3xl border border-border/60 bg-muted">
        {/* biome-ignore lint/performance/noImgElement: decorative art image loaded from a CDN constant, not a user upload */}
        <img src={AUTH_ART_URL} alt="" className="size-full object-cover" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
        <Link
          href="/"
          aria-label="Kvy home"
          className="absolute top-5 left-5 flex items-center gap-2.5 rounded-full bg-black/40 px-3.5 py-2 text-white backdrop-blur-sm transition-colors hover:bg-black/55"
        >
          <KvyMark className="size-6" />
          <span className="text-sm font-semibold tracking-tight">Kvy</span>
        </Link>
        <p className="absolute inset-x-0 bottom-6 text-center font-medium text-sm text-white/85">
          {caption}
        </p>
      </div>
    </aside>
  );
}
