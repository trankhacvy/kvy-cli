import Link from "next/link";
import { KvyMark } from "@/components/kvy-mark";
import { cn } from "@/lib/utils";

export function AuthBrandMark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5", className)}>
      <KvyMark className="size-8" />
      <span className="font-semibold tracking-tight">Kvy</span>
    </Link>
  );
}
