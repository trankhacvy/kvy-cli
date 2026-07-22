import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SpeechRecognitionFactory, SpeechRecognitionLike } from "./speech-input";
import { type UseSpeechInputResult, useSpeechInput } from "./use-speech-input";

// Same "pre-effect frame" technique as `use-connectivity.test.ts`/
// `use-machine-crypto.test.ts`: `renderToStaticMarkup` synchronously renders
// one pass and never flushes effects, so this only exercises `useSpeechInput`'s
// initial `useState` values (`start`/`stop` are plain callbacks, not effects,
// but calling them here wouldn't do anything observable without a second
// render pass this technique can't produce) — the actual listen/transcribe
// behavior driven by `start()` is exercised by hand against a real browser
// instead (no jsdom in this package's vitest config to fake a `MediaStream`
// permission prompt against anyway).
function fakeRecognition(): SpeechRecognitionLike {
  return {
    continuous: false,
    interimResults: false,
    lang: "",
    onresult: null,
    onerror: null,
    onend: null,
    start() {},
    stop() {},
  };
}

function renderSpeechInput(factory: SpeechRecognitionFactory | null): UseSpeechInputResult {
  let captured: UseSpeechInputResult | undefined;
  function Harness() {
    captured = useSpeechInput(() => {}, factory);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useSpeechInput", () => {
  it("reports unsupported when no SpeechRecognition factory is available", () => {
    const state = renderSpeechInput(null);
    expect(state.supported).toBe(false);
  });

  it("reports supported when a SpeechRecognition factory is available", () => {
    const state = renderSpeechInput(fakeRecognition);
    expect(state.supported).toBe(true);
  });

  it("starts not listening, with no error and no interim text, regardless of support", () => {
    for (const factory of [null, fakeRecognition]) {
      const state = renderSpeechInput(factory);
      expect(state.listening).toBe(false);
      expect(state.error).toBeNull();
      expect(state.interimText).toBe("");
    }
  });
});
