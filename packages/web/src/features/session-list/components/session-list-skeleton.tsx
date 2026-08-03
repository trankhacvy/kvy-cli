import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** One placeholder row, shaped like `SessionCard` — rendered while
 * `SessionListSnapshot.isLoading` is true and no sessions have appeared
 * yet, instead of the "No sessions yet" empty state flashing before the
 * real data arrives. */
function SessionCardSkeleton() {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="flex-row items-center gap-2 px-3">
        <Skeleton className="size-2.5 shrink-0 rounded-full" />
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-3 w-10 shrink-0" />
      </CardHeader>
      <CardContent className="flex items-center gap-2 px-3">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-3 w-14" />
      </CardContent>
    </Card>
  );
}

/** A skeleton "workspace section": a heading placeholder + a couple of
 * session-card placeholders, matching `WorkspaceSection`'s own shape. */
export function SessionListSkeleton() {
  return (
    <div
      role="status"
      className="flex flex-col gap-6"
      aria-label="Loading sessions"
      aria-busy="true"
    >
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <div className="flex flex-col gap-2">
            <SessionCardSkeleton />
            <SessionCardSkeleton />
          </div>
        </div>
      ))}
    </div>
  );
}
