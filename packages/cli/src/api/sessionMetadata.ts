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

const SessionMetadataValueSchema = z.object({
  title: z.string(),
  path: z.string(),
  providerSessionId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export interface SessionMetadataValue {
  title: string;
  path: string;
  providerSessionId?: string | null;
  model?: string | null;
}

export interface SessionMetadataUpdaterOptions {
  sessionId: string;
  serverUrl: string;
  token: string;
  dek: Uint8Array;
  metadata: SessionMetadataValue;
  metadataVersion: number;
  fetchImpl?: typeof fetch;
}

export interface SessionMetadataUpdater {
  updateModel(model: string): Promise<void>;
}

function normalizeMetadata(
  metadata: SessionMetadataValue,
): Required<SessionMetadataValue> {
  return {
    title: metadata.title,
    path: metadata.path,
    providerSessionId: metadata.providerSessionId ?? null,
    model: metadata.model ?? null,
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
): Required<SessionMetadataValue> {
  const opened = open(box, dek);
  const parsed = SessionMetadataValueSchema.safeParse(opened);
  if (!parsed.success) {
    throw new Error(
      "session metadata update conflict returned unreadable metadata",
    );
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

  async function persistModel(nextModel: string): Promise<void> {
    const normalizedModel = nextModel.trim();
    if (
      normalizedModel.length === 0 ||
      currentMetadata.model === normalizedModel
    )
      return;

    for (;;) {
      const nextMetadata: Required<SessionMetadataValue> = {
        ...currentMetadata,
        model: normalizedModel,
      };
      const response = await fetchImpl(
        `${serverUrl}/v1/sessions/${encodeURIComponent(options.sessionId)}/metadata`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.token}`,
          },
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
          currentMetadata = readMetadataFromBox(
            parsed.current.value,
            options.dek,
          );
          if (currentMetadata.model === normalizedModel) return;
        }
        continue;
      }

      const bodyText = await response.text().catch(() => "");
      throw describeFailure(response.status, bodyText);
    }
  }

  return {
    async updateModel(model: string): Promise<void> {
      const nextTask = queue
        .catch(() => undefined)
        .then(() => persistModel(model));
      queue = nextTask;
      return nextTask;
    },
  };
}
