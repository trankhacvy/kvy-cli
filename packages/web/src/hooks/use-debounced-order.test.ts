import { describe, expect, it } from "vitest";
import { applyKeyOrder } from "./use-debounced-order";

interface Item {
  id: string;
  label: string;
}

function item(id: string, label = id): Item {
  return { id, label };
}

describe("applyKeyOrder", () => {
  it("reorders items to follow the given key order", () => {
    const items = [item("a"), item("b"), item("c")];
    const result = applyKeyOrder(items, ["c", "a", "b"], (i) => i.id);
    expect(result.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("appends an item whose key isn't in the order, rather than dropping it", () => {
    const items = [item("a"), item("b"), item("new")];
    const result = applyKeyOrder(items, ["b", "a"], (i) => i.id);
    expect(result.map((i) => i.id)).toEqual(["b", "a", "new"]);
  });

  it("drops an ordered key that no longer has a matching item", () => {
    const items = [item("a")];
    const result = applyKeyOrder(items, ["gone", "a"], (i) => i.id);
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps live content, not the content from when the order was captured", () => {
    const items = [item("a", "fresh label")];
    const result = applyKeyOrder(items, ["a"], (i) => i.id);
    expect(result[0]?.label).toBe("fresh label");
  });

  it("returns an empty array for empty input", () => {
    expect(applyKeyOrder([], [], (i: Item) => i.id)).toEqual([]);
  });
});
