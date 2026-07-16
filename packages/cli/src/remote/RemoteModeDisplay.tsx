/**
 * Ported (adapted) from Happy — https://github.com/slopus/happy
 * Original: happy-cli/src/ui/ink/RemoteModeDisplay.tsx (MIT)
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
 * Remote-mode Ink status view (plan.md §16 "2.1 Remote mode": "Ink
 * `RemoteModeDisplay`: status view, streamed message summaries, keypress
 * handling"; design §7.4: `the terminal shows the Ink status view
 * ("controlled from web — Ctrl-T to take back")`).
 *
 * Keypress interpretation itself lives in `remoteModeKeypress.ts` (ported
 * verbatim from Happy's own "extracted so we can unit-test the reduce-style
 * logic without Ink/React" pure function) — same three gestures the
 * task/plan call out:
 *   - double-space within 15s confirms switching back to local/terminal
 *     control; Ctrl-T switches immediately, no confirmation.
 *   - double-Ctrl-C within 15s exits the whole client.
 *   - any other key cancels a pending confirmation.
 */
import { Box, Text, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BufferedMessage, MessageBuffer } from "./messageBuffer.js";
import {
  CONFIRMATION_TIMEOUT_MS,
  interpretRemoteModeKeypress,
  type RemoteModeActionInProgress,
  type RemoteModeConfirmation,
} from "./remoteModeKeypress.js";

export {
  CONFIRMATION_TIMEOUT_MS,
  interpretRemoteModeKeypress,
  type RemoteModeActionInProgress,
  type RemoteModeConfirmation,
  type RemoteModeKeyModifiers,
  type RemoteModeKeypressAction,
  type RemoteModeKeypressState,
} from "./remoteModeKeypress.js";

interface RemoteModeDisplayProps {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void;
  onSwitchToLocal?: () => void;
}

function messageColor(kind: BufferedMessage["kind"]): string {
  switch (kind) {
    case "user":
      return "magenta";
    case "assistant":
      return "cyan";
    case "system":
      return "blue";
    case "tool":
      return "yellow";
    case "result":
      return "green";
    case "status":
      return "gray";
  }
}

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({
  messageBuffer,
  logPath,
  onExit,
  onSwitchToLocal,
}) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [confirmationMode, setConfirmationMode] = useState<RemoteModeConfirmation>(null);
  const [actionInProgress, setActionInProgress] = useState<RemoteModeActionInProgress>(null);
  const confirmationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const terminalHeight = stdout.rows || 24;

  useEffect(() => {
    setMessages(messageBuffer.getMessages());
    const unsubscribe = messageBuffer.onUpdate(setMessages);
    return () => {
      unsubscribe();
      if (confirmationTimeoutRef.current) clearTimeout(confirmationTimeoutRef.current);
    };
  }, [messageBuffer]);

  const resetConfirmation = useCallback(() => {
    setConfirmationMode(null);
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
      confirmationTimeoutRef.current = null;
    }
  }, []);

  const setConfirmationWithTimeout = useCallback(
    (mode: Exclude<RemoteModeConfirmation, null>) => {
      setConfirmationMode(mode);
      if (confirmationTimeoutRef.current) clearTimeout(confirmationTimeoutRef.current);
      confirmationTimeoutRef.current = setTimeout(resetConfirmation, CONFIRMATION_TIMEOUT_MS);
    },
    [resetConfirmation],
  );

  useInput(
    useCallback(
      (input, key) => {
        const { action } = interpretRemoteModeKeypress({ confirmationMode, actionInProgress }, input, {
          ctrl: key.ctrl,
          meta: key.meta,
          shift: key.shift,
        });
        if (action === "none") return;
        if (action === "reset") {
          resetConfirmation();
          return;
        }
        if (action === "confirm-exit") {
          setConfirmationWithTimeout("exit");
          return;
        }
        if (action === "confirm-switch") {
          setConfirmationWithTimeout("switch");
          return;
        }
        if (action === "exit") {
          resetConfirmation();
          setActionInProgress("exiting");
          onExit?.();
          return;
        }
        if (action === "switch") {
          resetConfirmation();
          setActionInProgress("switching");
          onSwitchToLocal?.();
        }
      },
      [confirmationMode, actionInProgress, onExit, onSwitchToLocal, setConfirmationWithTimeout, resetConfirmation],
    ),
  );

  const visibleMessages = messages.slice(-Math.max(1, terminalHeight - 10));

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box
        flexDirection="column"
        width={terminalWidth}
        height={terminalHeight - 4}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text color="gray" bold>
            📡 Remote Mode — controlled from web
          </Text>
          <Text color="gray" dimColor>
            {"─".repeat(Math.min(terminalWidth - 4, 60))}
          </Text>
        </Box>

        <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
          {visibleMessages.length === 0 ? (
            <Text color="gray" dimColor>
              Waiting for messages...
            </Text>
          ) : (
            visibleMessages.map((msg) => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text color={messageColor(msg.kind)} dimColor>
                  {msg.content}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={
          actionInProgress
            ? "gray"
            : confirmationMode === "exit"
              ? "red"
              : confirmationMode === "switch"
                ? "yellow"
                : "green"
        }
        paddingX={2}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Box flexDirection="column" alignItems="center">
          {actionInProgress === "exiting" ? (
            <Text color="gray" bold>
              Exiting...
            </Text>
          ) : actionInProgress === "switching" ? (
            <Text color="gray" bold>
              Switching to local mode...
            </Text>
          ) : confirmationMode === "exit" ? (
            <Text color="red" bold>
              ⚠️ Press Ctrl-C again to exit completely
            </Text>
          ) : confirmationMode === "switch" ? (
            <Text color="yellow" bold>
              ⏸️ Press space again (or Ctrl-T) to switch to local mode
            </Text>
          ) : (
            <Text color="green" bold>
              📱 Press space (or Ctrl-T) to switch to local mode • Ctrl-C to exit
            </Text>
          )}
          {process.env.DEBUG && logPath && (
            <Text color="gray" dimColor>
              Debug logs: {logPath}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
