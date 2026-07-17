import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../persistence.js";
import { maybePromptShimOptIn } from "./onboardingPrompt.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-onboarding-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-onboarding-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

describe("maybePromptShimOptIn", () => {
  it("does nothing when non-interactive, but still marks onboarding complete", async () => {
    const { write, lines } = collectWrites();
    const confirm = vi.fn();

    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
      confirm,
      isInteractive: false,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(lines.join("")).toBe("");
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(true);
  });

  it("installs the shim when the user confirms interactively", async () => {
    const { write, lines } = collectWrites();
    const confirm = vi.fn(async () => true);

    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
      confirm,
      isInteractive: true,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(lines.join("")).toContain("Installed shims:");
    const rcContent = readFileSync(path.join(userHomeDir, ".profile"), "utf8");
    expect(rcContent).toContain("falcon shell shim");
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(true);
  });

  it("skips installing when the user declines, but still marks onboarding complete", async () => {
    const { write, lines } = collectWrites();
    const confirm = vi.fn(async () => false);

    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
      confirm,
      isInteractive: true,
    });

    expect(lines.join("")).toContain("Skipped.");
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(true);
  });

  it("is a no-op once onboarding is already completed", async () => {
    const { write: write1 } = collectWrites();
    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir, env: {} },
      write: write1,
      isInteractive: false,
    });

    const { write, lines } = collectWrites();
    const confirm = vi.fn();
    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
      confirm,
      isInteractive: true,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(lines.join("")).toBe("");
  });

  it("reports an install failure without throwing, and still marks onboarding complete", async () => {
    const { write, lines } = collectWrites();
    const confirm = vi.fn(async () => true);
    // A userHomeDir under a nonexistent parent with no permission to create
    // is hard to fabricate portably; instead point the rc file at a path
    // that collides with an existing directory, so writeFile fails.
    const collidingUserHome = path.join(userHomeDir, "collide");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(collidingUserHome), { recursive: true });
    mkdirSync(path.join(collidingUserHome, ".profile"), { recursive: true }); // a directory, not a file

    await maybePromptShimOptIn({
      persistenceOptions: { homeDir },
      shimOptions: { homeDir, userHomeDir: collidingUserHome, env: {} },
      write,
      confirm,
      isInteractive: true,
    });

    expect(lines.join("")).toContain("Could not install the shell shim");
    const settings = await readSettings({ homeDir });
    expect(settings.onboardingCompleted).toBe(true);
  });
});
