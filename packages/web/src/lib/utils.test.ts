import { describe, expect, it } from "vitest";
import { cn } from "./utils.js";

describe("cn", () => {
  it("joins plain class strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, 0, "", "b")).toBe("a b");
  });

  it("resolves conflicting Tailwind utilities in favor of the last one (tailwind-merge)", () => {
    // Same property (padding-x) specified twice — tailwind-merge should keep
    // only the last-writer, not naively concatenate both.
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("keeps non-conflicting classes from clsx + tailwind-merge together", () => {
    expect(cn("flex items-center", "gap-2")).toBe("flex items-center gap-2");
  });

  it("supports the conditional-object form clsx provides", () => {
    expect(cn("base", { hidden: false, block: true })).toBe("base block");
  });

  it("lets an explicit className override variant defaults, matching Button's usage", () => {
    // This is exactly how buttonVariants({ ..., className }) is composed in
    // src/components/ui/button.tsx: caller-supplied className must win.
    expect(cn("bg-primary text-primary-foreground", "bg-destructive")).toBe(
      "text-primary-foreground bg-destructive",
    );
  });

  it("returns an empty string for no input", () => {
    expect(cn()).toBe("");
  });
});
