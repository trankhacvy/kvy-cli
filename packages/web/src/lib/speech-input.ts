/**
 * Voice input (docs/competitive-notes-omnara.md #19 "voice input (microphone
 * icon) in the composer"). Wraps the browser's `SpeechRecognition` API,
 * which is unstandardized (Chrome/Edge/Safari ship it as
 * `webkitSpeechRecognition`/`SpeechRecognition`; Firefox has neither) —
 * there's no matching type in TS's DOM lib, so the shapes below are
 * hand-rolled to exactly the slice this file uses.
 *
 * Split into two pieces, same as `unifiedDiff.ts`/`diffHighlight.ts`'s
 * parse-vs-render split: `extractSpeechResult` is a pure function over a
 * plain data shape (fully unit-testable without a browser), while
 * `getSpeechRecognitionFactory` does the actual `window` feature-detection
 * `use-speech-input.ts`'s hook wires the two together.
 */

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly 0: { readonly transcript: string } | undefined;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

/** The narrow slice of the browser's `SpeechRecognition` instance this
 * feature needs — `start`/`stop` plus the three event callbacks, all it
 * takes to run one continuous, interim-results-enabled listening session. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type SpeechRecognitionFactory = () => SpeechRecognitionLike;

/** Reads the browser's speech-recognition constructor off `window` —
 * `null` in any environment lacking it (Firefox, most non-Chromium
 * browsers, SSR, this package's `vitest` `environment: "node"` config).
 * `useSpeechInput` treats a `null` factory as "unsupported" and the
 * composer shows a disabled mic with an explanatory tooltip instead of a
 * button that would silently do nothing when clicked. */
export function getSpeechRecognitionFactory(): SpeechRecognitionFactory | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? () => new Ctor() : null;
}

export interface SpeechResult {
  /** Concatenated `isFinal` transcript pieces from this event, in order —
   * empty string if this event carried none. */
  finalText: string;
  /** Concatenated still-being-spoken (non-final) transcript pieces — the
   * live "…transcribing" preview, replaced wholesale by the next event
   * rather than appended (mirrors how the browser itself keeps revising
   * its best guess for the current utterance until it's finalized). */
  interimText: string;
}

/**
 * Pure reducer over one `SpeechRecognition` `result` event
 * (`event.resultIndex` onward — everything before it was already reported
 * by an earlier event and must not be re-emitted, per the Web Speech API
 * spec). Fully unit-testable without constructing a real
 * `SpeechRecognitionEvent`.
 */
export function extractSpeechResult(event: SpeechRecognitionEventLike): SpeechResult {
  let finalText = "";
  let interimText = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    const transcript = result?.[0]?.transcript ?? "";
    if (!transcript) continue;
    if (result?.isFinal) {
      finalText += transcript;
    } else {
      interimText += transcript;
    }
  }
  return { finalText, interimText };
}

/** Human-readable message for a `SpeechRecognition` `error` event's `error`
 * code — the codes themselves (`"not-allowed"`, `"audio-capture"`, etc.) are
 * from the Web Speech API spec, not Falcon's own vocabulary. `"no-speech"`
 * (recognizer timed out waiting for audio) and `"aborted"` (the user's own
 * `stop()` call, or a session-ending `disabled` flip) are deliberately
 * *not* covered here — callers should treat those as silent, expected
 * events rather than surfacing an error message for normal
 * pause-then-stop dictation. */
export function describeSpeechError(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Voice input needs microphone permission. Check your browser's site settings.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Voice input lost its connection. Try again.";
    case "language-not-supported":
      return "Voice input doesn't support this language.";
    default:
      return `Voice input error: ${error}`;
  }
}

/** Appends a finalized voice transcript to the composer's existing draft
 * text — inserts a separating space when the existing text doesn't already
 * end in whitespace, so consecutive dictated sentences (or dictation after
 * manually typed text) don't run together word-to-word. */
export function appendTranscript(existing: string, transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return existing;
  if (existing.length === 0) return trimmed;
  return /\s$/.test(existing) ? `${existing}${trimmed}` : `${existing} ${trimmed}`;
}
