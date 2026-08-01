import type { TextItem } from "@/sync/reducer";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

/** A `text` render item: either a normal chat message or (when `thinking`)
 * a collapsible reasoning block (kvy-prd.md FR-7.2).
 *
 * Layout follows the Cursor/ChatGPT chat pattern: the user's message is a
 * bordered, muted rounded box (visually distinct but not a loud filled
 * bubble); the assistant's response is flat prose directly on the
 * background, with a small always-visible action row underneath (copy — the
 * `5s · ⧉` pattern, minus duration, which we don't track). */
export function MessageText({ item }: { item: TextItem }) {
  if (item.thinking) {
    return <ThinkingBlock md={item.md} />;
  }

  if (item.role === "user") {
    return (
      <div className="flex justify-start">
        <div className="w-fit max-w-[85%] rounded-2xl border border-border bg-muted/40 px-4 py-2.5">
          <Markdown md={item.md} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Markdown md={item.md} />
      <div className="mt-1.5 flex items-center gap-1">
        <CopyButton getText={() => item.md} />
      </div>
    </div>
  );
}
