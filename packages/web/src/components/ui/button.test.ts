import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("defaults to the 'default' variant and 'default' size when called with no args", () => {
    const classes = buttonVariants();
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
    expect(classes).toContain("h-9");
    expect(classes).toContain("px-2.5");
  });

  it("produces distinct classes per variant", () => {
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    const results = variants.map((variant) => buttonVariants({ variant }));

    // Each variant string should be unique — guards against a copy/paste bug
    // collapsing two variants onto the same styles.
    expect(new Set(results).size).toBe(variants.length);
  });

  it("produces distinct classes per size", () => {
    const sizes = ["default", "sm", "lg", "icon"] as const;
    const results = sizes.map((size) => buttonVariants({ size }));

    expect(new Set(results).size).toBe(sizes.length);
  });

  it("the 'destructive' variant carries destructive background/foreground tokens", () => {
    const classes = buttonVariants({ variant: "destructive" });
    expect(classes).toContain("bg-destructive/10");
    expect(classes).toContain("text-destructive");
  });

  it("the 'outline' variant is bordered and transparent-background by default", () => {
    const classes = buttonVariants({ variant: "outline" });
    expect(classes).toContain("border");
    expect(classes).toContain("border-input");
    expect(classes).toContain("bg-background");
  });

  it("merges a caller-supplied className via cn() (tailwind-merge conflict resolution)", () => {
    // buttonVariants pipes its output through cn() inside Button, but
    // buttonVariants itself is a plain cva() — verify the className slot
    // is accepted and appended so Button's cn(buttonVariants({..., className}))
    // composition (button.tsx line 50) has something real to merge.
    const classes = buttonVariants({ className: "custom-class" });
    expect(classes).toContain("custom-class");
  });

  it("always includes the disabled-state utilities regardless of variant/size", () => {
    const classes = buttonVariants({ variant: "ghost", size: "icon" });
    expect(classes).toContain("disabled:pointer-events-none");
    expect(classes).toContain("disabled:opacity-50");
  });
});
