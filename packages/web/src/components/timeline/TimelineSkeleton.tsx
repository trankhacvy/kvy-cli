import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder transcript, shown while a session's first message page (and
 * its DEK unwrap) are still in flight (plan-v2.md W4.2 "skeletons for …
 * timeline initial loads") — replaces a bare empty scroll area for that
 * window instead of letting it read as "this session really has nothing in
 * it yet". A handful of message-bubble-shaped rows of varying width, no
 * animation beyond `Skeleton`'s own pulse. */
export function TimelineSkeleton() {
  return (
    <div
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
