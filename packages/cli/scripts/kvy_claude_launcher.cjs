/**
 * Ported (verbatim) from Happy — https://github.com/slopus/happy
 * Original: happy/packages/happy-cli/scripts/claude_local_launcher.cjs
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
 * Falcon's local-mode Claude launcher (plan.md §6.3). Runs *inside* the same
 * process as the real Claude Code CLI (via `import()` below), so it patches
 * `global.fetch` before that CLI is loaded: every outbound request then
 * emits a `{type:'fetch-start', ...}` / `{type:'fetch-end', ...}` JSON line
 * on file descriptor 3. That's how the parent process (`claudeLocal.ts`,
 * spawning this script with `stdio: ['inherit','inherit','inherit','pipe']`)
 * renders a live "thinking" indicator without ever seeing request bodies —
 * only hostname + path are recorded, never the payload.
 *
 * stdout/stderr are deliberately never touched by this patch: fd 1/2 are
 * inherited straight through to the real Claude Code TUI, and (by default)
 * fd 3 is the only channel this script writes diagnostics to.
 *
 * ## PTY mode (`FALCON_FETCH_SIGNAL_PATH`)
 * When Falcon runs `claude` on a pseudo-terminal (the omnara-style PTY-
 * injection session — `ptyClaudeSession.ts`), there is no spare fd 3: a PTY
 * child inherits only the pty (fds 0/1/2), so `fs.writeSync(3, ...)` would
 * just EBADF. So if `FALCON_FETCH_SIGNAL_PATH` is set (a unix-domain socket
 * Falcon is already listening on), the SAME `fetch-start`/`fetch-end` JSON
 * lines are written there instead — Falcon derives its idle/busy signal
 * (used to gate web-message injection) from them exactly as it did off fd 3.
 * Absent that env var, behaviour is unchanged: fd 3 only.
 *
 * NOTE on `getClaudeCliPath()`: this is a small local stub, not the full
 * cross-install-method resolver (npm / Bun / Homebrew / native-installer
 * detection, `HAPPY_CLAUDE_PATH`-style override, etc.). That resolver is a
 * separate, already-in-flight bullet (`claude_version_utils.cjs` equivalent
 * / provider detection) and will replace this stub at integration time —
 * see plan.md §6.3. Don't duplicate that resolver here.
 */

const fs = require("node:fs");

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = "1";

// PTY mode: when Falcon runs claude on a pseudo-terminal there is no fd 3 to
// write to, so the fetch signal is delivered over a unix-domain socket Falcon
// is already listening on (path in FALCON_FETCH_SIGNAL_PATH). The socket is
// connected lazily on first use and messages are buffered until it's open;
// every failure is swallowed so a signal hiccup can never surface to the user
// or perturb the real Claude Code TUI. Falls back to fd 3 when unset.
const FETCH_SIGNAL_PATH = process.env.FALCON_FETCH_SIGNAL_PATH;
let signalSocket = null;
let signalConnecting = false;
const signalBacklog = [];

function flushSignalBacklog() {
  if (signalSocket?.writable !== true) return;
  while (signalBacklog.length > 0) {
    try {
      signalSocket.write(signalBacklog.shift());
    } catch (_err) {
      // Drop on write failure — a lost thinking-indicator tick is harmless.
    }
  }
}

function ensureSignalSocket() {
  if (signalSocket || signalConnecting) return;
  signalConnecting = true;
  try {
    const net = require("node:net");
    signalSocket = net.connect(FETCH_SIGNAL_PATH);
    signalSocket.on("connect", () => {
      signalConnecting = false;
      flushSignalBacklog();
    });
    // Never let an unhandled 'error' crash the in-process Claude Code CLI.
    signalSocket.on("error", () => {
      signalConnecting = false;
    });
  } catch (_err) {
    signalConnecting = false;
  }
}

// Helper to write JSON messages to the fetch-signal channel (unix socket in
// PTY mode, else fd 3).
function writeMessage(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (FETCH_SIGNAL_PATH) {
    signalBacklog.push(line);
    ensureSignalSocket();
    flushSignalBacklog();
    return;
  }
  try {
    fs.writeSync(3, line);
  } catch (_err) {
    // fd 3 not available, ignore
  }
}

// Intercept fetch to track thinking state
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = (...args) => {
  const id = ++fetchCounter;
  const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
  const method = args[1]?.method || "GET";

  // Parse URL for privacy
  let hostname = "";
  let path = "";
  try {
    const urlObj = new URL(url, "http://localhost");
    hostname = urlObj.hostname;
    path = urlObj.pathname;
  } catch (_e) {
    // If URL parsing fails, use defaults
    hostname = "unknown";
    path = url;
  }

  // Send fetch start event
  writeMessage({
    type: "fetch-start",
    id,
    hostname,
    path,
    method,
    timestamp: Date.now(),
  });

  // Execute the original fetch immediately
  const fetchPromise = originalFetch(...args);

  // Attach handlers to send fetch end event
  const sendEnd = () => {
    writeMessage({
      type: "fetch-end",
      id,
      timestamp: Date.now(),
    });
  };

  // Send end event on both success and failure
  fetchPromise.then(sendEnd, sendEnd);

  // Return the original promise unchanged
  return fetchPromise;
};

// Preserve fetch properties
Object.defineProperty(global.fetch, "name", { value: "fetch" });
Object.defineProperty(global.fetch, "length", { value: originalFetch.length });

/**
 * Resolve the Claude Code CLI entrypoint to launch. Local stub — see the
 * module header note above. Honors an explicit override env var; otherwise
 * falls back to the bare `claude` command name.
 * @returns {string} Path (or bare command name) to the Claude CLI.
 */
function getClaudeCliPath() {
  return process.env.FALCON_CLAUDE_PATH || "claude";
}

/**
 * Run the resolved Claude CLI. Mirrors the JS-file branch of Happy's
 * `runClaudeCli`: dynamic `import()` loads the CLI in this same process, so
 * the fetch/fd3 interceptors above stay active inside its module scope.
 *
 * Claude Code's native-binary installs (the standalone installer's
 * `~/.local/share/claude/versions/<ver>` — no `.js`/`.cjs` extension) can't
 * be `import()`-ed in-process, so for those this spawns the binary as a
 * child instead and forwards its exit code/signal. That's a real,
 * documented capability loss versus the JS-file path: a separate compiled
 * process can't have its `fetch` calls intercepted from out here, so binary
 * installs never get the fd3 "thinking" indicator. Args come from this
 * script's own `process.argv` (`claudeLocal.ts` spawns
 * `node falcon_claude_launcher.cjs <claude args...>`, so `argv.slice(2)` is
 * exactly the passthrough args either branch needs).
 * @param {string} cliPath - Path to the Claude CLI entrypoint.
 */
function runClaudeCli(cliPath) {
  const { pathToFileURL } = require("node:url");
  const isJsFile = cliPath.endsWith(".js") || cliPath.endsWith(".cjs");
  if (isJsFile) {
    const importUrl = pathToFileURL(cliPath).href;
    import(importUrl);
    return;
  }

  const { spawnSync } = require("node:child_process");
  const result = spawnSync(cliPath, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    // Re-raise the same signal on ourselves rather than inventing an exit
    // code — matches how a shell reports a signal-killed child (128+signum),
    // and lets the parent's own signal handling (if any) behave normally.
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

// Only launch when run directly (`node falcon_claude_launcher.cjs`), not
// when required by tests.
if (require.main === module) {
  runClaudeCli(getClaudeCliPath());
}

module.exports = { getClaudeCliPath, runClaudeCli, writeMessage };
