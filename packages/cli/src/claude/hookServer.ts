/**
 * Local-mode SessionStart hook server: loopback HTTP receiving Claude Code's
 * `SessionStart` hook so a `falcon claude` session process can learn the
 * *real* provider session UUID (plan.md §1.3; design §7.4/§8).
 *
 * Ported/adapted from happy-cli's `startHookServer.ts` +
 * `generateHookSettings.ts` (MIT), but mirrors this repo's already-merged
 * `packages/cli/src/daemon/controlServer.ts` exactly for style and
 * testability: Fastify bound to `127.0.0.1:0` (an OS-assigned ephemeral
 * port — the resolved port is what the caller substitutes into the
 * generated hook-settings file), zod-validated body, and every side effect
 * (`onSessionId`) injected by the caller rather than owned by this module.
 *
 * ## Why a hook instead of watching the transcript file for its name?
 * Claude Code's own transcript filename *is* the provider session UUID, but
 * discovering it by watching `~/.claude/projects/**` is racy once more than
 * one `falcon claude` process can be running (which file belongs to which
 * process?). The `SessionStart` hook instead has Claude Code tell this
 * specific process's server about its own session id directly — a 1:1
 * mapping with no race, matching Happy's rationale for preferring hooks
 * over file-watching for this purpose.
 *
 * ## Control flow (once wired into the launcher — see below)
 * ```
 * startHookServer({ onSessionId })   →  loopback server on 127.0.0.1:<port>
 * writeHookSettingsFile(dir, port)   →  <dir>/session-hook-<id>.json
 *                                        (SessionStart hook → forwarder.cjs)
 *                                        <dir>/falcon-hook-forwarder-<id>.cjs
 * spawn claude --settings <path>     →  Claude Code fires SessionStart
 *                                        → runs forwarder with hook JSON on
 *                                          stdin → POST /hook/session-start
 *                                        → onSessionId(realProviderUuid)
 * ```
 *
 * ## Explicitly OUT of scope here (documented follow-ups, not faked)
 * - Calling `PUT /v1/sessions/:id/metadata` (the CAS metadata-update route)
 *   once `onSessionId` fires — that HTTP route doesn't exist on `main` yet;
 *   it's part of the still-unmerged `P1-1.2-server-write-http` worktree.
 * - Wiring `startHookServer`/`writeHookSettingsFile` into the real
 *   `claudeLocal.ts` spawn flow and the `falcon_claude_launcher.cjs`
 *   launcher script — both are separate, currently in-flight plan bullets
 *   (`claudeLocal.ts` port, "Launcher `falcon_claude_launcher.cjs`").
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

// Claude Code's `SessionStart` hook payload. `session_id` is the one field
// this module cares about (the real provider session UUID); everything
// else passes through unvalidated via `.passthrough()` so a Claude Code
// version that adds/renames other fields never breaks this handler.
const SessionStartHookBodySchema = z
  .object({
    session_id: z.string().min(1),
  })
  .passthrough();

const SessionStartHookResponseSchema = z.object({ status: z.literal("ok") });

export interface HookServerDeps {
  /** Invoked with the real provider session UUID once `SessionStart` fires. */
  onSessionId: (sessionId: string) => void;
  logger?: Logger;
}

export interface HookServerHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start the loopback SessionStart hook server on an OS-assigned ephemeral
 * `127.0.0.1` port. Mirrors `startControlServer`'s promise/listen/resolve
 * shape exactly.
 */
export function startHookServer(deps: HookServerDeps): Promise<HookServerHandle> {
  const { onSessionId, logger } = deps;

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
          response: { 200: SessionStartHookResponseSchema },
        },
      },
      async (request) => {
        const { session_id: sessionId } = request.body;
        logger?.debug("[hook-server] session-start", { sessionId });
        onSessionId(sessionId);
        return { status: "ok" as const };
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

// A `SessionStart` "command" hook receives the hook payload as JSON on
// stdin and is otherwise on its own to deliver it somewhere — Claude Code
// does not POST anywhere itself. This script (written alongside the
// settings file so no repo-checked-in script is required) reads stdin and
// forwards it to this process's own hook server, mirroring happy-cli's
// `session_hook_forwarder.cjs` forwarder. Errors are swallowed: a forwarder
// failure must never surface as a Claude Code error to the user.
const FORWARDER_SCRIPT = `#!/usr/bin/env node
'use strict';
const http = require('node:http');
const port = Number(process.argv[2]);
if (!port || Number.isNaN(port)) process.exit(0);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/hook/session-start',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    },
    (res) => res.resume(),
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
 * Write a temp `--settings` file (design §7.4) configuring a `SessionStart`
 * hook that reports to the hook server listening on `port`. Writes a
 * companion forwarder script into the same directory since the hook
 * mechanism only supports shell "command" hooks, not a direct HTTP call.
 *
 * `dir` is caller-supplied (e.g. a `~/.falcon/tmp/hooks`-style directory)
 * rather than resolved here, keeping this module decoupled from
 * `resolveHomeDir`/the real launcher's directory conventions.
 */
export function writeHookSettingsFile(dir: string, port: number): HookSettingsFile {
  mkdirSync(dir, { recursive: true });

  const id = `${process.pid}-${randomUUID()}`;
  const forwarderPath = path.join(dir, `falcon-hook-forwarder-${id}.cjs`);
  const settingsPath = path.join(dir, `session-hook-${id}.json`);

  writeFileSync(forwarderPath, FORWARDER_SCRIPT, { mode: 0o755 });

  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `node ${JSON.stringify(forwarderPath)} ${port}` }],
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
