import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useRefetchOnMachineRecovery } from "./use-refetch-on-machine-recovery";

/**
 * `useRefetchOnMachineRecovery`'s actual behavior (the false->true transition
 * firing `onRecover`, an online-the-whole-time mount never firing it) is a
 * `useEffect` concern — this package's vitest runs with no jsdom and
 * `renderToStaticMarkup` never flushes effects (the same constraint
 * `use-git-panel.test.ts`'s own header comment documents), so a real
 * multi-render transition can't be exercised here. The one thing this DOES
 * prove: mounting alone, at any `machineOnline` value, never synchronously
 * invokes `onRecover` during render — the transition can only ever fire from
 * inside the (here, never-run) effect.
 */
describe("useRefetchOnMachineRecovery", () => {
  it("never calls onRecover synchronously while online during the initial render", () => {
    const onRecover = vi.fn();
    function Harness() {
      useRefetchOnMachineRecovery(true, onRecover);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(onRecover).not.toHaveBeenCalled();
  });

  it("never calls onRecover synchronously while offline during the initial render", () => {
    const onRecover = vi.fn();
    function Harness() {
      useRefetchOnMachineRecovery(false, onRecover);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(onRecover).not.toHaveBeenCalled();
  });
});
