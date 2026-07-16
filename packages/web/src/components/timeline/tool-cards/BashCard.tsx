import { Terminal } from "lucide-react";
import { parseBashArgs, parseBashOutput } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

export function BashCard({ item }: { item: ToolItem }) {
  const args = parseBashArgs(item.args);
  const output = parseBashOutput(item.output);
  const combinedOutput = [output.stdout, output.stderr].filter(Boolean).join("\n");

  return (
    <ToolCardShell item={item} icon={<Terminal className="size-4 text-muted-foreground" />}>
      {args.description && (
        <p className="mb-1.5 text-xs text-muted-foreground">{args.description}</p>
      )}
      <pre className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
        <code>{args.command ?? "(no command captured)"}</code>
      </pre>
      {combinedOutput.length > 0 ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs text-muted-foreground">
          <code>{combinedOutput}</code>
        </pre>
      ) : (
        output.stdout === undefined &&
        output.stderr === undefined &&
        item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />
      )}
    </ToolCardShell>
  );
}
