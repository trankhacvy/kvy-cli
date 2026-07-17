import { createEnvelope, type EncryptedBox, type SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { decryptMessageBatches, type MessageDecryptor } from "./messages.js";
import type { MessageItem, MessagesPage } from "./types.js";

function box(c: string): EncryptedBox {
  return { t: "enc", v: 1, c };
}

function messageRow(seq: number, content: EncryptedBox): MessageItem {
  return { seq, localId: null, content, createdAt: 1000 + seq };
}

function page(messages: MessageItem[], nextBefore: number | null = null): MessagesPage {
  return { messages, nextBefore };
}

/** A `MessageDecryptor` double keyed by the box's `c` field — mirrors the
 * real `CryptoBridgeClient.open`'s contract (`null` on any decrypt
 * failure), without a real worker. */
function fakeCrypto(entries: Record<string, unknown>): MessageDecryptor {
  return {
    open: async <T>(box: EncryptedBox) => {
      if (!(box.c in entries)) return null;
      return entries[box.c] as T;
    },
  };
}

describe("decryptMessageBatches", () => {
  it("decrypts and flattens batches across rows and pages", async () => {
    const e1 = createEnvelope("user", { t: "text", md: "hi" }, { id: "e1", time: 1 });
    const e2 = createEnvelope("agent", { t: "turn-start" }, { id: "e2", time: 2 });
    const e3 = createEnvelope(
      "agent",
      { t: "turn-end", status: "completed" },
      { id: "e3", time: 3 },
    );

    const crypto = fakeCrypto({
      "batch-1": [e1, e2] satisfies SessionEnvelope[],
      "batch-2": [e3] satisfies SessionEnvelope[],
    });

    const result = await decryptMessageBatches(
      [page([messageRow(1, box("batch-1"))]), page([messageRow(2, box("batch-2"))])],
      crypto,
    );

    expect(result).toEqual([e1, e2, e3]);
  });

  it("logs and drops a row that fails to decrypt, without dropping the rest", async () => {
    const e1 = createEnvelope("user", { t: "text", md: "hi" }, { id: "e1", time: 1 });
    const crypto = fakeCrypto({ "good-batch": [e1] satisfies SessionEnvelope[] });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await decryptMessageBatches(
      [page([messageRow(1, box("undecryptable")), messageRow(2, box("good-batch"))])],
      crypto,
    );

    expect(result).toEqual([e1]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("logs and drops a row whose decrypted content fails schema validation", async () => {
    const crypto = fakeCrypto({ malformed: { not: "an envelope array" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await decryptMessageBatches([page([messageRow(1, box("malformed"))])], crypto);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("returns an empty array for no pages", async () => {
    const result = await decryptMessageBatches([], fakeCrypto({}));
    expect(result).toEqual([]);
  });
});
