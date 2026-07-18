import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFetchSignalServer,
  type FetchSignalEvent,
  type FetchSignalServer,
} from "./ptyFetchSignal.js";

describe("createFetchSignalServer", () => {
  let server: FetchSignalServer | null = null;
  let client: Socket | null = null;

  afterEach(async () => {
    client?.destroy();
    client = null;
    await server?.close();
    server = null;
  });

  it("parses newline-delimited fetch events from a connected writer and drops malformed lines", async () => {
    const events: FetchSignalEvent[] = [];
    server = await createFetchSignalServer({
      homeDir: "/unused",
      onEvent: (event) => events.push(event),
    });
    expect(server.path).not.toBe("");

    client = connect(server.path);
    await new Promise<void>((resolve, reject) => {
      client?.on("connect", () => resolve());
      client?.on("error", reject);
    });

    // A partial line, a malformed line, and two well-formed events split
    // across writes — the parser must reassemble on newline boundaries.
    client.write('{"type":"fetch-start","id":1}\n{"type":"garb');
    client.write('age"}\nnot json at all\n{"type":"fetch-end","id":1}\n');

    await vi.waitFor(() => {
      expect(events).toEqual([
        { type: "fetch-start", id: 1 },
        { type: "fetch-end", id: 1 },
      ]);
    });
  });
});
