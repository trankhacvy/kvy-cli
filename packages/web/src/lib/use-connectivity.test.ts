import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectivitySource, ConnectivityState } from "./use-connectivity";
import { useConnectivity } from "./use-connectivity";

// Same "pre-effect frame" technique as `use-machine-crypto.test.ts`:
// `renderToStaticMarkup` never flushes `useEffect`, so neither of
// `useConnectivity`'s two effects (window online/offline, source
// connect/disconnect) ever run here — this exercises exactly the initial
// `useState` values, which is also the only frame reachable in this
// package's `environment: "node"` vitest config (no `window`/`navigator` to
// begin with, matching the hook's own "no DOM" fallback).
function fakeSource(isConnected: boolean, isAuthExpired = false): ConnectivitySource {
  return {
    isConnected: () => isConnected,
    isAuthExpired: () => isAuthExpired,
    on: () => () => {},
  };
}

function renderConnectivity(source: ConnectivitySource): ConnectivityState {
  let captured: ConnectivityState | undefined;
  function Harness() {
    captured = useConnectivity(source);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useConnectivity", () => {
  it("reports online: true under a DOM-less environment (no navigator to say otherwise)", () => {
    expect(renderConnectivity(fakeSource(true)).online).toBe(true);
  });

  it("reflects the source's isConnected() at mount as wsConnected", () => {
    expect(renderConnectivity(fakeSource(true)).wsConnected).toBe(true);
  });

  it("reflects a disconnected source", () => {
    expect(renderConnectivity(fakeSource(false)).wsConnected).toBe(false);
  });

  it("online and wsConnected are independent signals", () => {
    const state = renderConnectivity(fakeSource(false));
    expect(state.online).toBe(true);
    expect(state.wsConnected).toBe(false);
  });

  it("reflects the source's isAuthExpired() at mount as authExpired", () => {
    expect(renderConnectivity(fakeSource(true, true)).authExpired).toBe(true);
  });

  it("defaults authExpired to false when the source reports no auth failure", () => {
    expect(renderConnectivity(fakeSource(true, false)).authExpired).toBe(false);
  });
});
