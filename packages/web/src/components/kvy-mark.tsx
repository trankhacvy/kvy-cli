import { cn } from "@/lib/utils";

export function KvyMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex overflow-hidden rounded-lg", className)}>
      {/* biome-ignore lint/performance/noImgElement: static icon from public dir, no dynamic sizing needed */}
      <img src="/manifest-icon-512.maskable.png" alt="" className="size-full object-cover" />
    </span>
  );
}
