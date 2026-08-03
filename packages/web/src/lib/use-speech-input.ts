"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractSpeechResult,
  getSpeechRecognitionFactory,
  type SpeechRecognitionFactory,
  type SpeechRecognitionLike,
} from "./speech-input";

export interface UseSpeechInputResult {
  /** False in any browser lacking the Web Speech API (Firefox, most
   * non-Chromium browsers) — the mic button renders disabled with an
   * explanatory tooltip in that case rather than one that does nothing. */
  supported: boolean;
  listening: boolean;
  /** The live, not-yet-finalized transcript of the utterance currently
   * being spoken — for a "…transcribing" preview, not the composer's
   * actual draft text. Cleared once its words are finalized (moved to
   * `onFinalResult`) or listening stops. */
  interimText: string;
  /** Last recognition error (`"not-allowed"` for a denied mic permission,
   * `"no-speech"`, `"network"`, etc., verbatim from the browser) — cleared
   * on the next `start()`. */
  error: string | null;
  start(): void;
  stop(): void;
}

/**
 * Thin, testable wrapper around the browser's `SpeechRecognition`.
 * Mirrors
 * `use-connectivity.ts`'s injectable-source pattern: the real
 * `getSpeechRecognitionFactory()` default reads `window`; tests inject a
 * fake `SpeechRecognitionFactory` instead so the start/stop/result
 * plumbing is exercisable without a real browser or microphone.
 *
 * Runs `continuous`+`interimResults` so one tap starts an open-ended
 * dictation session (stopped by a second tap, not by the browser's own
 * short-utterance timeout) — `onFinalResult` fires once per finalized
 * phrase, letting the caller append each one to the composer's draft as
 * it's recognized rather than waiting for the whole session to end.
 */
export function useSpeechInput(
  onFinalResult: (transcript: string) => void,
  factory: SpeechRecognitionFactory | null = getSpeechRecognitionFactory(),
): UseSpeechInputResult {
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;

  // Captured once at mount (lazy `useState` initializer) — feature support
  // doesn't change mid-session, and this keeps `start`'s identity stable
  // across renders instead of re-deriving a fresh factory function every
  // time (the default parameter above would otherwise construct a new
  // closure on every call).
  const [recognitionFactory] = useState(() => factory);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!recognitionFactory || recognitionRef.current) return;
    const recognition = recognitionFactory();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    recognition.onresult = (event) => {
      const { finalText, interimText: nextInterim } = extractSpeechResult(event);
      if (finalText) onFinalResultRef.current(finalText);
      setInterimText(nextInterim);
    };
    recognition.onerror = (event) => {
      setError(event.error);
      // A denied/unavailable mic never recovers on its own — flip
      // `listening` back off immediately rather than leaving the button
      // looking stuck "on" until some later `onend` (some browsers don't
      // reliably fire `onend` after certain errors).
      if (event.error === "not-allowed" || event.error === "audio-capture") {
        setListening(false);
        setInterimText("");
        recognitionRef.current = null;
      }
    };
    recognition.onend = () => {
      setListening(false);
      setInterimText("");
      recognitionRef.current = null;
    };
    setError(null);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [recognitionFactory]);

  // Stop listening on unmount (a session switch remounts `Composer` in
  // practice) rather than leaking an open microphone stream.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return { supported: recognitionFactory !== null, listening, interimText, error, start, stop };
}
