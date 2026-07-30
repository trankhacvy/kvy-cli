"use client";

import { useEffect, useRef, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Measures a ref'd element's content box via `ResizeObserver`, for
 * libraries that need explicit pixel `width`/`height` rather than filling
 * their container via CSS (`react-arborist`'s `<Tree>` — Feature 3, docs/
 * web-ux-improvements-plan.md Phase 3 — has no built-in auto-sizer, unlike
 * `@tanstack/react-virtual`'s scroll-element-driven approach).
 *
 * Starts at `{width: 0, height: 0}` — callers must treat that as "not
 * measured yet, don't render the sized child" the same way `useMachineOnline`
 * treats "unknown" as distinct from a real value, not fall back to a guess.
 */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, ElementSize] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
