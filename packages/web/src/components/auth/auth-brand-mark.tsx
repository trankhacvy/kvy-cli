import Link from "next/link";
import { KvyMark } from "@/components/kvy-mark";
import { cn } from "@/lib/utils";

/**
 * The mark + wordmark link to `/`, shared by every unprotected auth screen. Callers
 * that also render `AuthArtPanel` (which carries its own copy of this mark) hide
 * this one at ≥lg via `className` — it exists so the same branding still shows on
 * mobile, where the art panel is hidden.
 */
export function AuthBrandMark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5", className)}>
      <KvyMark className="size-8" />
      <span className="font-semibold tracking-tight">Kvy</span>
    </Link>
  );
}
