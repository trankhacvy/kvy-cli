import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./errors.js";

describe("isUniqueViolation", () => {
  it("returns true for a bare driver-shaped error with code 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("returns true for a DrizzleQueryError-shaped wrapper (code lives on .cause)", () => {
    // Mirrors what drizzle-orm 0.45's pg-core actually throws for both drivers
    // this package runs against (`postgres` in prod, `@electric-sql/pglite` in
    // tests): the raw driver error is nested one level down on `.cause`, not
    // on the wrapper's own `.code` (which is `undefined`).
    const wrapped = new Error("Failed query: insert into ...");
    (wrapped as { cause?: unknown }).cause = { code: "23505" };
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("returns false for a different SQLSTATE (e.g. a foreign-key violation)", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    const wrapped = new Error("fk violation");
    (wrapped as { cause?: unknown }).cause = { code: "23503" };
    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
    expect(isUniqueViolation(new Error("plain error, no code"))).toBe(false);
  });

  it("doesn't loop forever on a self-referential cause chain", () => {
    const circular = new Error("circular");
    (circular as { cause?: unknown }).cause = circular;
    expect(isUniqueViolation(circular)).toBe(false);
  });
});
