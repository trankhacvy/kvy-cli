import { describe, expect, it } from "vitest";
import { isDirectoryNotFoundError } from "../components/directory-step-logic";
import { createMockNewSessionActions } from "../mock-source";
import { runSpawnFlow } from "../spawn-flow";
import type { SpawnRequest } from "../types";

describe("isDirectoryNotFoundError", () => {
  it("matches the daemon's fs.list not-found message shape", () => {
    expect(isDirectoryNotFoundError("directory not found: /Users/vy/projects/new-idea")).toBe(
      true,
    );
  });

  it("does not match other browse failures", () => {
    expect(isDirectoryNotFoundError("path must be absolute: relative/path")).toBe(false);
    expect(isDirectoryNotFoundError("could not list /root: EACCES")).toBe(false);
  });
});

/**
 * Regression test for the gap this logic closes: DirectoryStep only ever
 * called `onSelect` with a *browsed* listing's path, so `form.directory`
 * could never hold a not-yet-existing path and the create-directory
 * approval loop (`runSpawnFlow`) was unreachable from typing a brand-new
 * project directory. This drives the same actions the component uses
 * (`mock-source.ts`) end-to-end: browse a path that 404s, confirm the error
 * is the "not found" kind `isDirectoryNotFoundError` gates the "use this
 * path anyway" affordance on, then feed that not-yet-existing path straight
 * into `spawn`/`runSpawnFlow` the same way selecting it in the wizard would.
 */
describe("selecting a not-yet-existing directory (DirectoryStep 'use this path anyway')", () => {
  it("lets a typed, never-browsed-successfully path flow through spawn's create-directory approval loop", async () => {
    const actions = createMockNewSessionActions("mach-laptop");
    const newPath = "/Users/vy/projects/new-idea";

    await expect(actions.browseDirectory(newPath)).rejects.toThrow(/directory not found/i);

    // This is exactly the message DirectoryStep's catch block inspects to
    // decide whether to offer "use this path anyway" for `newPath`.
    let notFoundMessage = "";
    try {
      await actions.browseDirectory(newPath);
    } catch (err) {
      notFoundMessage = err instanceof Error ? err.message : String(err);
    }
    expect(isDirectoryNotFoundError(notFoundMessage)).toBe(true);

    // Selecting it (the fix's new affordance) hands `newPath` straight to
    // spawn, unmediated by any listing — this is what was previously
    // impossible.
    const request: SpawnRequest = {
      directory: newPath,
      provider: "claude-code",
      permissionMode: "default",
    };
    const result = await runSpawnFlow(actions, request, async () => true);
    expect(result).toEqual({ outcome: "spawned", sessionId: expect.any(String) });

    // The directory now exists — browsing it no longer 404s.
    const listing = await actions.browseDirectory(newPath);
    expect(listing.path).toBe(newPath);
  });
});
