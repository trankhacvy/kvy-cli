/**
 * Zod schema for the JSONL lines Claude Code writes to its transcript files
 * (`~/.claude/projects/<project>/<sessionId>.jsonl`).
 *
 * Ported from happy-cli/src/claude/types.ts (MIT). Trimmed to only the
 * fields the scanner actually reads (message identity for dedup keys) —
 * everything else passes through untouched via `.passthrough()` so we never
 * reject a line just because Claude Code added a field we don't know about.
 */

import { z } from "zod";

export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message — `uuid` is used as the dedup key.
  z
    .object({
      type: z.literal("user"),
      isSidechain: z.boolean().optional(),
      isMeta: z.boolean().optional(),
      uuid: z.string(),
    })
    .passthrough(),

  // Assistant message — `uuid` is used as the dedup key. The `message`
  // object is intentionally not validated here: synthetic error messages
  // (`isApiErrorMessage: true`) and other SDK-version variance can shape it
  // differently, and this scanner never reads its contents.
  z
    .object({
      type: z.literal("assistant"),
      uuid: z.string(),
    })
    .passthrough(),

  // Summary message — dedup key is derived from `leafUuid` + `summary`.
  z
    .object({
      type: z.literal("summary"),
      summary: z.string(),
      leafUuid: z.string(),
    })
    .passthrough(),

  // System message — `uuid` is used as the dedup key.
  z
    .object({
      type: z.literal("system"),
      uuid: z.string(),
    })
    .passthrough(),
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>;
