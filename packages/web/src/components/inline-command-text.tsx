import { Fragment } from "react";
import { Kbd } from "@/components/ui/kbd";

/**
 * Renders plain text with backtick-delimited segments (`` `kvy` ``) as real
 * `<kbd>` chips instead of literal backtick characters — copy.ts strings use
 * backticks to mark a literal command name, but a bare `{copy.pair.approveWarning}`
 * text node prints them as-is rather than styling them. No markdown lib: this only
 * ever needs to split on a single delimiter, never nested or escaped.
 */
export function InlineCommandText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: `parts` is a fresh array from a full re-split every render — there's no reordering/mutation for index-as-key to get wrong.
        <Fragment key={i}>{i % 2 === 1 ? <Kbd>{part}</Kbd> : part}</Fragment>
      ))}
    </>
  );
}
