import { cn } from "@/lib/utils";

export function FalconMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex overflow-hidden rounded-lg", className)}>
      <img src="/icon-512.png" alt="" className="size-full object-cover" />
    </span>
  );
}
