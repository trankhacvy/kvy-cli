import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  describeSpeechError,
  extractSpeechResult,
  getSpeechRecognitionFactory,
  type SpeechRecognitionEventLike,
} from "./speech-input";

function event(
  resultIndex: number,
  results: Array<{ transcript: string; isFinal: boolean }>,
): SpeechRecognitionEventLike {
  return {
    resultIndex,
    results: results.map((r) => ({
      isFinal: r.isFinal,
      length: 1,
      0: { transcript: r.transcript },
    })),
  };
}

describe("extractSpeechResult", () => {
  it("returns an interim transcript for a still-being-spoken result", () => {
    const result = extractSpeechResult(event(0, [{ transcript: "hello wor", isFinal: false }]));
    expect(result).toEqual({ finalText: "", interimText: "hello wor" });
  });

  it("returns a final transcript once the browser finalizes it", () => {
    const result = extractSpeechResult(event(0, [{ transcript: "hello world", isFinal: true }]));
    expect(result).toEqual({ finalText: "hello world", interimText: "" });
  });

  it("starts from resultIndex, ignoring results already reported by an earlier event", () => {
    const result = extractSpeechResult(
      event(1, [
        { transcript: "hello world", isFinal: true },
        { transcript: "second sentence", isFinal: false },
      ]),
    );
    expect(result).toEqual({ finalText: "", interimText: "second sentence" });
  });

  it("concatenates multiple final results in the same event", () => {
    const result = extractSpeechResult(
      event(0, [
        { transcript: "hello world. ", isFinal: true },
        { transcript: "second sentence.", isFinal: true },
      ]),
    );
    expect(result).toEqual({ finalText: "hello world. second sentence.", interimText: "" });
  });

  it("returns empty strings for an event with no results", () => {
    expect(extractSpeechResult(event(0, []))).toEqual({ finalText: "", interimText: "" });
  });

  it("tolerates a missing transcript at an index (defensive — shouldn't happen in practice)", () => {
    const malformed: SpeechRecognitionEventLike = {
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: undefined }],
    };
    expect(extractSpeechResult(malformed)).toEqual({ finalText: "", interimText: "" });
  });
});

describe("appendTranscript", () => {
  it("returns the trimmed transcript as-is onto empty existing text", () => {
    expect(appendTranscript("", "hello world")).toBe("hello world");
  });

  it("inserts a separating space when existing text doesn't end in whitespace", () => {
    expect(appendTranscript("existing draft", "hello world")).toBe("existing draft hello world");
  });

  it("doesn't double up a space when existing text already ends in whitespace", () => {
    expect(appendTranscript("existing draft ", "hello world")).toBe("existing draft hello world");
  });

  it("trims the transcript's own leading/trailing whitespace before appending", () => {
    expect(appendTranscript("existing", "  hello world  ")).toBe("existing hello world");
  });

  it("is a no-op for a blank transcript", () => {
    expect(appendTranscript("existing draft", "   ")).toBe("existing draft");
  });
});

describe("describeSpeechError", () => {
  it("explains a denied mic permission", () => {
    expect(describeSpeechError("not-allowed")).toMatch(/microphone permission/i);
    expect(describeSpeechError("service-not-allowed")).toMatch(/microphone permission/i);
  });

  it("explains a missing microphone", () => {
    expect(describeSpeechError("audio-capture")).toMatch(/no microphone/i);
  });

  it("explains a network failure", () => {
    expect(describeSpeechError("network")).toMatch(/connection/i);
  });

  it("explains an unsupported language", () => {
    expect(describeSpeechError("language-not-supported")).toMatch(/language/i);
  });

  it("falls back to a generic message with the raw code for anything else", () => {
    expect(describeSpeechError("some-future-error-code")).toBe(
      "Voice input error: some-future-error-code",
    );
  });
});

describe("getSpeechRecognitionFactory", () => {
  it('returns null under a DOM-less environment (this package\'s vitest `environment: "node"`)', () => {
    expect(getSpeechRecognitionFactory()).toBeNull();
  });
});
