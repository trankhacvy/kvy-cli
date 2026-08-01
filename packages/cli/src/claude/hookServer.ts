/**
 * Local-mode Claude Code lifecycle hook server: loopback HTTP receiving
 * Claude Code's `SessionStart`, `Notification`, and `Stop` hooks (plan.md
 * §1.3/§2.3; design §7.4/§8).
 *
 * Ported/adapted from happy-cli's `startHookServer.ts` +
 * `generateHookSettings.ts` (MIT), but mirrors this repo's already-merged
 * `packages/cli/src/daemon/controlServer.ts` exactly for style and
 * testability: Fastify bound to `127.0.0.1:0` (an OS-assigned ephemeral
 * port — the resolved port is what the caller substitutes into the
 * generated hook-settings file), zod-validated bodies, and every side
 * effect (`onSessionId`, `onAttention`) injected by the caller rather than
 * owned by this module.
 *
 * ## Why a hook instead of watching the transcript file for its name?
 * Claude Code's own transcript filename *is* the provider session UUID, but
 * discovering it by watching `~/.claude/projects/**` is racy once more than
 * one `kvy claude` process can be running (which file belongs to which
 * process?). The `SessionStart` hook instead has Claude Code tell this
 * specific process's server about its own session id directly — a 1:1
 * mapping with no race, matching Happy's rationale for preferring hooks
 * over file-watching for this purpose.
 *
 * ## `Notification`/`Stop` → local-mode honesty (plan.md §2.3)
 * Local mode's real Claude Code TTY owns its own permission prompts — the
 * permission pipeline (`permissionHandler.ts`) is remote-mode-only by
 * construction, so there is no way (and no need) to fake a remote answer
 * here. What local mode *can* honestly do is tell the dashboard "the agent
 * is waiting at the terminal" the moment Claude Code itself says so:
 * - `Notification` fires whenever Claude Code needs the human at the
 *   keyboard — either a tool-permission prompt ("Claude needs your
 *   permission to use Bash") or an idle-waiting nudge ("Claude is waiting
 *   for your input"). Claude Code doesn't expose a separate boolean for
 *   which case it is, so `attentionKindFromNotificationMessage` reads the
 *   `message` text as the only available signal — `perm` if it mentions a
 *   permission prompt, `question` otherwise. A future Claude Code release
 *   changing this copy degrades to always reporting `question`, never to
 *   silence (`.passthrough()` + an optional `message` field), which stays
 *   honest either way — the dashboard still learns *something* needs
 *   attention.
 * - `Stop` fires once the main agent turn actually finishes, reported as
 *   `done` unconditionally — no message parsing needed.
 * Both map onto the same `AttentionKind` the already-built server route
 * (`POST /v1/sessions/:id/notify`, design §6.4) accepts, so whichever
 * caller wires `onAttention` in (the still-unbuilt local-launcher
 * integration — see "Explicitly OUT of scope" below) can forward it
 * verbatim over the existing session-scoped HTTP/WS path without any
 * translation layer here.
 *
 * ## Control flow (once wired into the launcher — see below)
 * ```
 * startHookServer({ onSessionId, onAttention })
 *                                    →  loopback server on 127.0.0.1:<port>
 * writeHookSettingsFile(dir, port)  →  <dir>/session-hook-<id>.json
 *                                       (SessionStart/Notification/Stop →
 *                                        forwarder.cjs)
 *                                       <dir>/kvy-hook-forwarder-<id>.cjs
 * spawn claude --settings <path>    →  Claude Code fires SessionStart
 *                                       → forwarder POSTs stdin JSON to
 *                                         /hook/session-start
 *                                       → onSessionId(realProviderUuid)
 *                                    →  Claude Code fires Notification/Stop
 *                                       → forwarder POSTs to
 *                                         /hook/notification or /hook/stop
 *                                       → onAttention("perm"|"question"|"done")
 * ```
 *
 * ## Explicitly OUT of scope here (documented follow-ups, not faked)
 * - Calling `PUT /v1/sessions/:id/metadata` (the CAS metadata-update route)
 *   once `onSessionId` fires — that HTTP route doesn't exist on `main` yet;
 *   it's part of the still-unmerged `P1-1.2-server-write-http` worktree.
 * - Actually calling `POST /v1/sessions/:id/notify` (or emitting over the
 *   session-scoped WS client, `session/sessionClient.ts`) once `onAttention`
 *   fires — both need Kvy's own `sessionId` + an auth token, neither of
 *   which this loopback hook server (one per Claude Code *provider* process,
 *   keyed by no Kvy identity at all) has any business owning. `onAttention`
 *   is the seam a caller that does hold those wires the real network call
 *   through, exactly like `onSessionId` today.
 * - Wiring `startHookServer`/`writeHookSettingsFile` into the real
 *   `claudeLocal.ts` spawn flow and the `kvy_claude_launcher.cjs`
 *   launcher script — both are separate, currently in-flight plan bullets
 *   (`claudeLocal.ts` port, "Launcher `kvy_claude_launcher.cjs`").
 * This module is fully decoupled via callback injection (like
 * `controlServer.ts`'s `deps` pattern) precisely so it can be wired in
 * later without changes here.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { Logger } from "../logger.js";
import {
  HOOK_COMMAND_TIMEOUT_SECONDS,
  type PermissionRequestHookInput,
  type PermissionRequestHookOutput,
  type PreToolUseHookInput,
  type PreToolUseHookOutput,
} from "./pretoolPermissionBridge.js";

/** The lifecycle-signal kinds a local-mode session can honestly report —
 * the subset of `@kvy/wire`'s `LifecycleKind` that `POST
 * /v1/sessions/:id/notify` accepts (`failed` has its own richer route,
 * `sessionStatus.ts`, and isn't something a hook ever reports). */
export type AttentionKind = "perm" | "question" | "done";

// Claude Code's `SessionStart` hook payload. `session_id` is the one field
// this module cares about (the real provider session UUID); everything
// else passes through unvalidated via `.passthrough()` so a Claude Code
// version that adds/renames other fields never breaks this handler.
const SessionStartHookBodySchema = z
  .object({
    session_id: z.string().min(1),
  })
  .passthrough();

// Claude Code's `Notification` hook payload. `message` is the only signal
// available for distinguishing a permission prompt from a plain idle-wait
// nudge (see the module doc above) — nullish (absent, `undefined`, *or*
// explicit `null`) + passthrough so a missing/renamed/null-valued field
// never breaks the handler (never a 400 that silently drops the hook), just
// falls back to `question`.
const NotificationHookBodySchema = z
  .object({
    message: z.string().nullish(),
  })
  .passthrough();

// Claude Code's `Stop` hook payload. Nothing in the body affects the
// outcome — firing at all means the turn ended — so every field is
// optional/passthrough.
const StopHookBodySchema = z.object({}).passthrough();

// Claude Code's `PreToolUse` hook payload (verified against 2.1.212).
// `tool_name` is the only strictly-required field; `tool_input`/
// `permission_mode` are optional + everything passes through so a Claude Code
// version that adds/renames fields never turns a real permission prompt into
// a dropped 400.
const PreToolUseHookBodySchema = z
  .object({
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    permission_mode: z.string().optional(),
  })
  .passthrough();

// The `PreToolUse` hook's stdout JSON (see `pretoolPermissionBridge.ts`). The
// forwarder streams this response body back to Claude Code as the hook's own
// stdout.
const PreToolUseHookOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: z.enum(["allow", "deny", "ask"]),
    permissionDecisionReason: z.string().optional(),
  }),
  suppressOutput: z.literal(true),
});

/** When no `onPreToolUse` is wired, defer every tool to the normal TUI prompt. */
const PRE_TOOL_USE_ASK: PreToolUseHookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
  },
  suppressOutput: true,
};

// Claude Code's `PermissionRequest` hook payload (verified against 2.1.214,
// plan-v2.md W0.3) — fires only for calls that survive Claude Code's own
// settings/allowlist/mode evaluation and would genuinely show a dialog.
// `tool_name` is the only strictly-required field; `tool_input` and
// Claude Code's own `permission_suggestions` (e.g. "allow this command
// always") pass through unvalidated — surfaced later (Wave 4), never
// required here.
const PermissionRequestHookBodySchema = z
  .object({
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    // Present per the verified contract (plan-v2.md W0.3); typed explicitly
    // (rather than left to `.passthrough()`'s catchall) so the PTY
    // `setMode` mode-cache (plan-v2.md W4.3, `pretoolPermissionBridge.ts`'s
    // `cachePermissionMode`) reads it type-safely off `request.body`.
    permission_mode: z.string().optional(),
  })
  .passthrough();

const HookOkResponseSchema = z.object({ status: z.literal("ok") });

/**
 * Derives the `AttentionKind` for a `Notification` hook firing, from its
 * `message` text — the only signal Claude Code exposes for which of the two
 * `Notification` cases this is (see the module doc's "`Notification`/`Stop`"
 * section). Exported for direct unit testing of the heuristic in isolation.
 */
export function attentionKindFromNotificationMessage(
  message: string | null | undefined,
): AttentionKind {
  return message != null && /permission/i.test(message) ? "perm" : "question";
}

export interface HookServerDeps {
  /** Invoked with the real provider session UUID once `SessionStart` fires. */
  onSessionId: (sessionId: string) => void;
  /**
   * Invoked when Claude Code's `Notification` or `Stop` hook fires — the
   * local-mode signal that the dashboard should show "waiting at the
   * terminal" (plan.md §2.3). Optional: a caller that hasn't wired the
   * downstream notify call yet (or a `SessionStart`-only test) simply omits
   * it and these hooks become no-ops beyond logging.
   */
  onAttention?: (kind: AttentionKind) => void;
  /**
   * Invoked when Claude Code's `PreToolUse` hook fires — a tool is about to
   * run and Kvy gets to approve/deny/defer it (design §7.6, remote
   * permission answering). Resolves with the `PreToolUse` output the
   * forwarder writes back to Claude Code as the hook's stdout. Optional: when
   * omitted, every tool is deferred to the normal TUI prompt (`ask`), so a
   * caller that only wants the lifecycle hooks stays unaffected. May block
   * (awaiting a web answer) up to the bridge's own timeout.
   */
  onPreToolUse?: (input: PreToolUseHookInput) => Promise<PreToolUseHookOutput>;
  /**
   * Invoked when Claude Code's `PermissionRequest` hook fires — a permission
   * dialog is genuinely about to be shown (design §7.6, plan-v2.md Wave 1.1).
   * Resolve with a decision to answer it remotely, or with `undefined` to let
   * the TUI dialog render normally (the local-turn escape hatch). Optional:
   * when omitted, every call gets a 204 (no decision), so a caller that only
   * wants the lifecycle/`PreToolUse` hooks stays unaffected.
   */
  onPermissionRequest?: (
    input: PermissionRequestHookInput,
  ) => Promise<PermissionRequestHookOutput | undefined>;
  logger?: Logger;
}

export interface HookServerHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start the loopback lifecycle-hook server on an OS-assigned ephemeral
 * `127.0.0.1` port. Mirrors `startControlServer`'s promise/listen/resolve
 * shape exactly.
 */
export function startHookServer(deps: HookServerDeps): Promise<HookServerHandle> {
  const { onSessionId, onAttention, onPreToolUse, onPermissionRequest, logger } = deps;

  return new Promise((resolve, reject) => {
    const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // The forwarder script (see `writeHookSettingsFile` below) POSTs the
    // hook's stdin JSON here verbatim.
    app.post(
      "/hook/session-start",
      {
        schema: {
          body: SessionStartHookBodySchema,
          response: { 200: HookOkResponseSchema },
        },
      },
      async (request) => {
        const { session_id: sessionId } = request.body;
        logger?.debug("[hook-server] session-start", { sessionId });
        onSessionId(sessionId);
        return { status: "ok" as const };
      },
    );

    // Claude Code needs the human at the terminal — permission prompt or
    // idle-waiting nudge, see the module doc's honesty section above.
    app.post(
      "/hook/notification",
      {
        schema: {
          body: NotificationHookBodySchema,
          response: { 200: HookOkResponseSchema },
        },
      },
      async (request) => {
        const kind = attentionKindFromNotificationMessage(request.body.message);
        logger?.debug("[hook-server] notification", { kind, message: request.body.message });
        onAttention?.(kind);
        return { status: "ok" as const };
      },
    );

    // The main agent turn finished — reported unconditionally as `done`.
    app.post(
      "/hook/stop",
      {
        schema: {
          body: StopHookBodySchema,
          response: { 200: HookOkResponseSchema },
        },
      },
      async () => {
        logger?.debug("[hook-server] stop");
        onAttention?.("done");
        return { status: "ok" as const };
      },
    );

    // A tool is about to run — route it through Kvy's permission pipeline
    // (design §7.6). This handler may block until the web answers (or the
    // bridge times out); the forwarder holds the hook open and streams this
    // JSON back to Claude Code as the hook's stdout.
    app.post(
      "/hook/pre-tool-use",
      {
        schema: {
          body: PreToolUseHookBodySchema,
          response: { 200: PreToolUseHookOutputSchema },
        },
      },
      async (request) => {
        logger?.debug("[hook-server] pre-tool-use", { toolName: request.body.tool_name });
        if (!onPreToolUse) return PRE_TOOL_USE_ASK;
        return onPreToolUse(request.body as PreToolUseHookInput);
      },
    );

    // A permission dialog is genuinely about to be shown — Claude Code's own
    // settings/allowlist/mode evaluation already ran (design §7.6, plan-v2.md
    // Wave 1.1). A 204 (no `onPermissionRequest`, or it resolves with
    // `undefined`) means "no decision" — the forwarder writes nothing and
    // Claude Code's normal TUI dialog renders.
    app.post(
      "/hook/permission-request",
      { schema: { body: PermissionRequestHookBodySchema } },
      async (request, reply) => {
        logger?.debug("[hook-server] permission-request", { toolName: request.body.tool_name });
        const out = onPermissionRequest
          ? await onPermissionRequest(request.body as PermissionRequestHookInput)
          : undefined;
        if (!out) {
          return reply.code(204).send();
        }
        return out;
      },
    );

    app.listen({ port: 0, host: "127.0.0.1" }, (err, address) => {
      if (err) {
        logger?.debug("[hook-server] failed to start", {
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
        return;
      }

      const port = Number(address.split(":").pop());
      logger?.debug("[hook-server] started", { port });

      resolve({
        port,
        stop: async () => {
          logger?.debug("[hook-server] stopping");
          await app.close();
          logger?.debug("[hook-server] stopped");
        },
      });
    });
  });
}

// A hook "command" receives its hook's payload as JSON on stdin and is
// otherwise on its own to deliver it somewhere — Claude Code does not POST
// anywhere itself. This script (written alongside the settings file so no
// repo-checked-in script is required) reads stdin and forwards it verbatim
// to this process's own hook server, mirroring happy-cli's
// `session_hook_forwarder.cjs` forwarder. It's shared by all five hooks
// (`SessionStart`/`Notification`/`Stop`/`PreToolUse`/`PermissionRequest`) —
// the settings file passes each hook's own endpoint path as the second argv
// so one script covers all of them.
//
// The `SessionStart`/`Notification`/`Stop` hooks are fire-and-forget: the
// response is drained and ignored, and any error is swallowed so a forwarder
// failure never surfaces as a Claude Code error to the user.
//
// The `PreToolUse` and `PermissionRequest` hooks are DIFFERENT: they are
// blocking, request/response decision hooks. The forwarder must (1) keep the
// request open until the server responds (the server holds it until the web
// answers or its own timeout), and (2) write the server's 200 response body
// verbatim to its OWN stdout — that JSON IS the hook's decision
// (`PreToolUse`'s `permissionDecision` allow/deny/ask, or `PermissionRequest`'s
// `decision.behavior` allow/deny). On any non-200 (including
// `PermissionRequest`'s 204 "no decision"), it writes nothing and exits 0,
// which Claude Code treats as "no decision" → its normal TUI permission
// prompt (a safe fallback that never wedges the tool).
const FORWARDER_SCRIPT = `#!/usr/bin/env node
'use strict';
const http = require('node:http');
const port = Number(process.argv[2]);
const hookPath = process.argv[3];
if (!port || Number.isNaN(port) || !hookPath) process.exit(0);
const blocking = hookPath === '/hook/pre-tool-use' || hookPath === '/hook/permission-request';
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: hookPath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    },
    (res) => {
      if (!blocking) {
        res.resume();
        return;
      }
      const out = [];
      res.on('data', (chunk) => out.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            process.stdout.write(Buffer.concat(out));
          } catch {}
        }
      });
    },
  );
  req.on('error', () => {});
  req.end(body);
});
process.stdin.resume();
`;

export interface HookSettingsFile {
  /** Absolute path to pass as Claude Code's `--settings <path>`. */
  path: string;
  /** Removes the generated settings file and its companion forwarder script. Best-effort. */
  cleanup: () => void;
}

/**
 * Write a temp `--settings` file (design §7.4) configuring `SessionStart`,
 * `Notification`, `Stop`, `PreToolUse`, and `PermissionRequest` hooks that all
 * report to the hook server listening on `port`, each hitting its own
 * endpoint via one shared forwarder script written into the same directory
 * (the hook mechanism only supports shell "command" hooks, not a direct HTTP
 * call). The first three are fire-and-forget lifecycle signals;
 * `PreToolUse`/`PermissionRequest` are the blocking remote-permission-
 * answering hooks (design §7.6, plan-v2.md Wave 1.1) — `PreToolUse` always
 * defers (`ask`), and `PermissionRequest` is where the web-vs-terminal fork
 * actually lives (fires only for calls that would genuinely show a dialog).
 *
 * `dir` is caller-supplied (e.g. a `~/.kvy/tmp/hooks`-style directory)
 * rather than resolved here, keeping this module decoupled from
 * `resolveHomeDir`/the real launcher's directory conventions.
 */
export function writeHookSettingsFile(dir: string, port: number): HookSettingsFile {
  mkdirSync(dir, { recursive: true });

  const id = `${process.pid}-${randomUUID()}`;
  const forwarderPath = path.join(dir, `kvy-hook-forwarder-${id}.cjs`);
  const settingsPath = path.join(dir, `session-hook-${id}.json`);

  writeFileSync(forwarderPath, FORWARDER_SCRIPT, { mode: 0o755 });

  const command = (hookPath: string) => `node ${JSON.stringify(forwarderPath)} ${port} ${hookPath}`;

  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "*", hooks: [{ type: "command", command: command("/hook/session-start") }] },
      ],
      Notification: [
        { matcher: "*", hooks: [{ type: "command", command: command("/hook/notification") }] },
      ],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: command("/hook/stop") }] }],
      // The PreToolUse hook is the blocking permission-decision hook (design
      // §7.6). `timeout` (seconds) is the outer bound Claude Code waits for
      // the forwarder — kept comfortably above the bridge's own answer
      // timeout so the bridge always resolves first (as a clean deny) rather
      // than letting Claude Code's "hook did not respond" path fire.
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: command("/hook/pre-tool-use"),
              timeout: HOOK_COMMAND_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
      // The PermissionRequest hook is where the web-vs-terminal fork actually
      // lives (design §7.6, plan-v2.md Wave 1.1): it fires only for calls
      // Claude Code's own settings/allowlist/mode evaluation decided
      // genuinely need a human. Same blocking/timeout shape as PreToolUse.
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: command("/hook/permission-request"),
              timeout: HOOK_COMMAND_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return {
    path: settingsPath,
    cleanup: () => {
      for (const filePath of [settingsPath, forwarderPath]) {
        try {
          unlinkSync(filePath);
        } catch {
          // Best-effort cleanup only — a leaked temp file is harmless.
        }
      }
    },
  };
}
