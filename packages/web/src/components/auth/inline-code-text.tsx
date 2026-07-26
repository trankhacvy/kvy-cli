import { Fragment } from "react";

/**
 * Renders plain text with backtick-delimited segments (`` `falcon` ``) as real
 * `<code>` chips instead of literal backtick characters — copy.ts strings use
 * backticks to mark a literal command name, but a bare `{copy.pair.approveWarning}`
 * text node prints them as-is rather than styling them. No markdown lib: this only
 * ever needs to split on a single delimiter, never nested or escaped.
 */
export function InlineCodeText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i % 2 === 1 ? (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{part}</code>
          ) : (
            part
          )}
        </Fragment>
      ))}
    </>
  );
}
