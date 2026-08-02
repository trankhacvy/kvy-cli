import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder transcript shown while the first message page is loading —
 * replaces a bare empty scroll area so it doesn't read as "this session
 * has nothing in it yet". */
export function TimelineSkeleton() {
  return (
    <div
      role="status"
      className="flex flex-1 flex-col gap-4 overflow-hidden p-4"
      aria-label="Loading transcript"
      aria-busy="true"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-16 w-2/3 rounded-lg" />
      </div>
      <div className="flex flex-col gap-2 self-end">
        <Skeleton className="h-3 w-16 self-end" />
        <Skeleton className="h-10 w-1/2 rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-24 w-3/4 rounded-lg" />
      </div>
    </div>
  );
}
