import { open, seal } from "@falcon/crypto";
import { EncryptedBoxSchema } from "@falcon/wire";
import { z } from "zod";

const CasOkSchema = z.object({ version: z.number().int().nonnegative() });
const CasConflictSchema = z.object({
  current: z.object({
    value: EncryptedBoxSchema.nullable(),
    version: z.number().int().nonnegative(),
  }),
});

// `looseObject`, not `object`: this blob is also written by the web (Pin —
// docs/features/session-lifecycle-actions.md Phase 3/4 — and any future
// field), which the CLI knows nothing about. A strict schema would silently
// strip those unknown keys on parse, and the next CLI-side updateModel CAS
// write would then re-seal a blob missing them — clobbering a concurrent
// writer instead of converging with it.
const SessionMetadataValueSchema = z.looseObject({
  title: z.string(),
  path: z.string(),
  providerSessionId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  /** `"auto"` (machine-set — the working-directory basename, or a
   * provider-generated summary) vs `"manual"` (a human renamed it, via
   * `rename-session-dialog.tsx`). `updateTitle` below refuses to overwrite a
   * `"manual"` title. Optional/absent is treated the same as `"auto"` — a
   * pre-existing row sealed before this field existed has no marker at all,
   * and defaulting that to "still safe to auto-title" is the same
   * conservative choice `bootstrap.ts` makes for every fresh session. */
  titleSource: z.enum(["auto", "manual"]).optional(),
});

export interface SessionMetadataValue {
  title: string;
  path: string;
  providerSessionId?: string | null;
  model?: string | null;
  titleSource?: "auto" | "manual";
  [extra: string]: unknown;
}

export interface SessionMetadataUpdaterOptions {
  sessionId: string;
  serverUrl: string;
  /**
   * Resolves the current bearer token immediately before every request (including every
   * CAS-conflict retry inside `persistModel`) instead of a token captured once at
   * construction — same fix, same reason, as `httpClient.ts`'s `getAuthToken`
   * (docs/known-issues-cliweb-sync-test.md issue #1: a session can run far longer than
   * one access token's ~15min TTL). Typically `TokenProvider.getAccessToken`.
   */
  getAuthToken: () => string | null | Promise<string | null>;
  dek: Uint8Array;
  metadata: SessionMetadataValue;
  metadataVersion: number;
  fetchImpl?: typeof fetch;
}

export interface SessionMetadataUpdater {
  updateModel(model: string): Promise<void>;
  /** Proposes an auto-title (e.g. the provider's own transcript summary
   * line) — a no-op once the session has been manually renamed. See
   * `SessionMetadataValueSchema`'s `titleSource` doc comment. */
  updateTitle(title: string): Promise<void>;
}

type NormalizedMetadata = Required<
  Pick<SessionMetadataValue, "title" | "path" | "providerSessionId" | "model">
> &
  Pick<SessionMetadataValue, "titleSource"> &
  Record<string, unknown>;

// Spreads ALL parsed keys (preserving unknown fields like the web's
// `pinned`) and then overlays only the fields this module actually knows
// about, so a round-trip through here never drops a foreign key.
function normalizeMetadata(metadata: SessionMetadataValue): NormalizedMetadata {
  return {
    ...metadata,
    title: metadata.title,
    path: metadata.path,
    providerSessionId: metadata.providerSessionId ?? null,
    model: metadata.model ?? null,
    titleSource: metadata.titleSource,
  };
}

function describeFailure(status: number, bodyText: string): Error {
  return new Error(
    bodyText.length > 0
      ? `session metadata update failed with ${status}: ${bodyText}`
      : `session metadata update failed with ${status}`,
  );
}

function readMetadataFromBox(
  box: z.infer<typeof EncryptedBoxSchema>,
  dek: Uint8Array,
): NormalizedMetadata {
  const opened = open(box, dek);
  const parsed = SessionMetadataValueSchema.safeParse(opened);
  if (!parsed.success) {
    throw new Error("session metadata update conflict returned unreadable metadata");
  }
  return normalizeMetadata(parsed.data);
}

export function createSessionMetadataUpdater(
  options: SessionMetadataUpdaterOptions,
): SessionMetadataUpdater {
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverUrl = options.serverUrl.replace(/\/+$/, "");

  let currentMetadata = normalizeMetadata(options.metadata);
  let currentVersion = options.metadataVersion;
  let queue = Promise.resolve();

  /**
   * Generic CAS-retry loop shared by `persistModel`/`persistTitle`:
   * `computeNext` is re-run against the freshest known `currentMetadata` on
   * every attempt (including after a 409 reload), so it doubles as the
   * "already satisfied, nothing to write" check — returning `null` (no
   * change needed, or a guard like `persistTitle`'s manual-title check
   * blocked it) short-circuits without a network call.
   */
  async function persistPatch(
    computeNext: (current: NormalizedMetadata) => NormalizedMetadata | null,
  ): Promise<void> {
    for (;;) {
      const nextMetadata = computeNext(currentMetadata);
      if (nextMetadata === null) return;

      const token = await options.getAuthToken();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;

      const response = await fetchImpl(
        `${serverUrl}/v1/sessions/${encodeURIComponent(options.sessionId)}/metadata`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            expectedVersion: currentVersion,
            value: seal(nextMetadata, options.dek),
          }),
        },
      );

      if (response.ok) {
        const parsed = CasOkSchema.parse(await response.json());
        currentMetadata = nextMetadata;
        currentVersion = parsed.version;
        return;
      }

      if (response.status === 409) {
        const parsed = CasConflictSchema.parse(await response.json());
        currentVersion = parsed.current.version;
        if (parsed.current.value) {
          currentMetadata = readMetadataFromBox(parsed.current.value, options.dek);
        }
        continue;
      }

      const bodyText = await response.text().catch(() => "");
      throw describeFailure(response.status, bodyText);
    }
  }

  function persistModel(nextModel: string): Promise<void> {
    const normalizedModel = nextModel.trim();
    if (normalizedModel.length === 0) return Promise.resolve();
    return persistPatch((current) =>
      current.model === normalizedModel ? null : { ...current, model: normalizedModel },
    );
  }

  function persistTitle(nextTitle: string): Promise<void> {
    const normalizedTitle = nextTitle.trim();
    if (normalizedTitle.length === 0) return Promise.resolve();
    return persistPatch((current) => {
      // Never overwrite a title the user set by hand — this updater only
      // ever proposes an *auto* title (provider summary line today).
      if (current.titleSource === "manual") return null;
      if (current.title === normalizedTitle && current.titleSource === "auto") return null;
      return { ...current, title: normalizedTitle, titleSource: "auto" };
    });
  }

  return {
    async updateModel(model: string): Promise<void> {
      const nextTask = queue.catch(() => undefined).then(() => persistModel(model));
      queue = nextTask;
      return nextTask;
    },
    async updateTitle(title: string): Promise<void> {
      const nextTask = queue.catch(() => undefined).then(() => persistTitle(title));
      queue = nextTask;
      return nextTask;
    },
  };
}
