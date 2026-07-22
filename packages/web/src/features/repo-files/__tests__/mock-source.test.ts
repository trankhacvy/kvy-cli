import { describe, expect, it } from "vitest";
import { createMockRepoFilesActions } from "../mock-source";

describe("createMockRepoFilesActions", () => {
  it("fetchFileList returns a non-empty file list", async () => {
    const actions = createMockRepoFilesActions("mach-1");
    const files = await actions.fetchFileList("/repo");

    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("README.md");
  });

  it("fetchFileContent for a known path returns non-truncated content", async () => {
    const actions = createMockRepoFilesActions("mach-1");
    const files = await actions.fetchFileList("/repo");
    const target = files[0] as string;

    const content = await actions.fetchFileContent("/repo", target);
    expect(content.truncated).toBe(false);
    expect(content.inline).toBeTruthy();
  });

  it("fetchFileContent for every listed file returns some inline content", async () => {
    const actions = createMockRepoFilesActions("mach-1");
    const files = await actions.fetchFileList("/repo");

    for (const file of files) {
      const content = await actions.fetchFileContent("/repo", file);
      expect(content.inline).toBeTruthy();
    }
  });

  it("fetchFileContent for an unknown path falls back to a default placeholder mentioning the path", async () => {
    const actions = createMockRepoFilesActions("mach-1");
    const content = await actions.fetchFileContent("/repo", "some/unknown/path.ts");
    expect(content.inline).toContain("some/unknown/path.ts");
  });
});
