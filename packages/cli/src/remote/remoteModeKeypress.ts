/**
 * Ported verbatim from Happy — https://github.com/slopus/happy
 * `interpretRemoteModeKeypress` (MIT) — split into its own module so it can
 * than pulling the Ink/React/JSX toolchain into a test that only exercises
 * this pure reduce-style function.
 *
 * MIT License
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 * 15s confirms switching back to local/terminal control (Ctrl-T switches
 * immediately, no confirmation needed); double-Ctrl-C within 15s exits the
 * whole client; any other key cancels a pending confirmation.
 */

/** How long a double-space/double-Ctrl-C confirmation stays armed. */
export const CONFIRMATION_TIMEOUT_MS = 15_000;

export type RemoteModeConfirmation = "exit" | "switch" | null;
export type RemoteModeActionInProgress = "exiting" | "switching" | null;

export type RemoteModeKeypressAction =
  | "none"
  | "reset"
  | "confirm-exit"
  | "confirm-switch"
  | "exit"
  | "switch";

export interface RemoteModeKeypressState {
  confirmationMode: RemoteModeConfirmation;
  actionInProgress: RemoteModeActionInProgress;
}

export interface RemoteModeKeyModifiers {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Pure interpretation of a keypress against current confirmation state.
 * Extracted so the reduce-style logic is unit-testable without Ink/React.
 */
export function interpretRemoteModeKeypress(
  state: RemoteModeKeypressState,
  input: string,
  key: RemoteModeKeyModifiers = {},
): { action: RemoteModeKeypressAction } {
  if (state.actionInProgress) return { action: "none" };

  // Ctrl-C handling: first press arms the exit confirmation, second confirms.
  if (key.ctrl && input === "c") {
    return { action: state.confirmationMode === "exit" ? "exit" : "confirm-exit" };
  }

  // Ctrl-T: immediate switch to terminal — avoids the buffered "space spam"
  // failure mode where extra space presses leak into the next interactive
  // child process after Ink unmounts.
  if (key.ctrl && input === "t") {
    return { action: "switch" };
  }

  // Double-space confirmation for switching.
  if (input === " ") {
    return { action: state.confirmationMode === "switch" ? "switch" : "confirm-switch" };
  }

  // Any other key cancels a pending confirmation.
  if (state.confirmationMode) {
    return { action: "reset" };
  }

  return { action: "none" };
}
