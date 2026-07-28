"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function useDebouncedValue<T>(value: T, delayMs: number, paused: boolean): T {
  const [debounced, setDebounced] = useState(value);
  const latest = useRef(value);
  latest.current = value;

  // `value` is read via `latest.current`, not directly, but must stay a
  // dependency: the debounce only works if a new `value` restarts this
  // timer, which requires the effect to re-run on every change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (paused) return;
    const id = setTimeout(() => setDebounced(latest.current), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs, paused]);

  return debounced;
}

/** Reorders `items` to follow `order` (a list of keys), appending any item
 * whose key isn't in `order` at the end rather than dropping it. */
export function applyKeyOrder<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const ordered: T[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (item) ordered.push(item);
  }
  for (const item of items) {
    if (!order.includes(keyOf(item))) ordered.push(item);
  }
  return ordered;
}

/**
 * Keeps `items` fully live (content updates immediately), but debounces the
 * ORDER they're rendered in, and freezes reordering entirely while `paused`
 * is true.
 */
export function useDebouncedOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  delayMs: number,
  paused: boolean,
): T[] {
  const keys = useMemo(() => items.map(keyOf), [items, keyOf]);
  const debouncedKeys = useDebouncedValue(keys, delayMs, paused);

  return useMemo(
    () => applyKeyOrder(items, debouncedKeys, keyOf),
    [items, debouncedKeys, keyOf],
  );
}
