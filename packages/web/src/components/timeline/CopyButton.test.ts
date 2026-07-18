import { describe, expect, it } from "vitest";
import { copyButtonLabel } from "./CopyButton";

describe("copyButtonLabel", () => {
  it("reads the resting label when not in the copied-flash state", () => {
    expect(copyButtonLabel(false, "Copy")).toBe("Copy");
  });

  it("reads 'Copied' during the post-click flash, regardless of the resting label", () => {
    expect(copyButtonLabel(true, "Copy")).toBe("Copied");
    expect(copyButtonLabel(true, "Copy command")).toBe("Copied");
  });
});
