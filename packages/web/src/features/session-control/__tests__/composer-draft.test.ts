import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import { clearDraft, loadDraft, saveDraft } from "../composer-draft.js";

describe("composer-draft (no window)", () => {
  it("loadDraft/saveDraft/clearDraft are safe no-ops without crashing", () => {
    expect(loadDraft("sess-1")).toBe("");
    expect(() => saveDraft("sess-1", "hello")).not.toThrow();
    expect(() => clearDraft("sess-1")).not.toThrow();
  });
});

describe("composer-draft (window.sessionStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns '' for a session with no saved draft", () => {
    expect(loadDraft("sess-1")).toBe("");
  });

  it("saveDraft persists text that loadDraft then returns", () => {
    saveDraft("sess-1", "hello world");
    expect(loadDraft("sess-1")).toBe("hello world");
  });

  it("keys are scoped per session id", () => {
    saveDraft("sess-1", "first");
    saveDraft("sess-2", "second");
    expect(loadDraft("sess-1")).toBe("first");
    expect(loadDraft("sess-2")).toBe("second");
  });

  it("saveDraft with whitespace-only text clears any existing draft instead of saving it", () => {
    saveDraft("sess-1", "real draft");
    saveDraft("sess-1", "   ");
    expect(loadDraft("sess-1")).toBe("");
  });

  it("clearDraft removes a saved draft outright", () => {
    saveDraft("sess-1", "in progress");
    clearDraft("sess-1");
    expect(loadDraft("sess-1")).toBe("");
  });
});
