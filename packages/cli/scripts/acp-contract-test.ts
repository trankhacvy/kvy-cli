#!/usr/bin/env node
/**
 * ACP adapter contract test (kvy-system-design.md §13.2 v0.3, plan.md §17
 * Phase 2.4). The v2 sibling of `provider-contract-test.ts`: instead of the
 * local Claude Code transcript/hook/resume contract, this exercises Kvy's
 * REAL ACP stack (`src/acp/acpConnection.ts` + `acpToEnvelope.ts` +
 * `acpPermissionHandler.ts`) against the official `claude-agent-acp` adapter,
 * asserting the ACP-side behaviors Kvy's mapper depends on but does not
 * control:
 *
 *  1. **Handshake** — `initialize` returns an `agentInfo`, and `session/new`
 *     returns a UUID-shaped `sessionId` (the id Kvy reuses for the
 *     remote→local `claude --resume <id>` handoff — design §7.4).
 *  2. **Text turn** — a plain prompt produces `agent_message_chunk`
 *     notifications that the mapper coalesces into ≥1 `text` envelope, and
 *     `session/prompt` resolves with `stopReason: "end_turn"`.
 *  3. **Tool turn** — a Bash prompt produces a `tool_call` carrying
 *     `_meta.claudeCode.toolName` (mapper assumption 2) whose args stream in
 *     via refinements (deferred tool-start), mapped to a `tool-start` named
 *     for the real tool + a `tool-end`.
 *
 * It runs TWICE (design §13.2 "pinned + latest canary"):
 *  - **pinned** (`ADAPTER_MANIFEST`) — a failure here is a HARD failure
 *    (exit 1): Kvy ships against exactly this version.
 *  - **latest** (`@agentclientprotocol/claude-agent-acp@latest`, temp-installed
 *    only when it differs from the pin) — a failure here is a loud WARNING,
 *    not a red build: it means upstream drifted and Kvy should investigate
 *    before bumping its pin, not that Kvy is currently broken.
 *
 * Standalone, billed, live — never part of `pnpm test`. Invoked only by
 * `.github/workflows/provider-contract.yml`'s daily cron (Claude installed +
 * authenticated). Local run: `pnpm --filter kvy run contract:acp`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { SessionEnvelope } from "@kvy/wire";
import { AcpConnection } from "../src/acp/acpConnection.js";
import {
  type AcpSessionUpdate,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
} from "../src/acp/acpToEnvelope.js";
import { installAllAdapters } from "../src/adapters/install.js";
import { ADAPTER_MANIFEST } from "../src/adapters/manifest.js";

class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_TIMEOUT_MS = 180_000;

/** Auto-allows every permission request (picks `allow_once`, or the first offered option). */
async function autoAllow(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  const options = params.options ?? [];
  const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
  if (!allow) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: allow.optionId } };
}

/** Drives one prompt turn through a real AcpConnection + the mapper; returns the emitted envelopes. */
async function runTurn(
  connection: AcpConnection,
  sessionId: string,
  prompt: string,
): Promise<{ envelopes: SessionEnvelope[]; stopReason: string }> {
  const state = createAcpEnvelopeMapperState();
  const envelopes: SessionEnvelope[] = [startAcpTurn(state)];
  const unsubscribe = connection.onSessionUpdate((notification) => {
    envelopes.push(...mapAcpUpdateToEnvelopes(notification.update as AcpSessionUpdate, state));
  });
  try {
    const result = await Promise.race([
      connection.prompt(sessionId, [{ type: "text", text: prompt }]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("prompt timed out")), TURN_TIMEOUT_MS),
      ),
    ]);
    envelopes.push(...endAcpTurn(state, result.stopReason));
    return { envelopes, stopReason: result.stopReason };
  } finally {
    unsubscribe();
  }
}

/** Runs the full contract against an already-installed adapter at `homeDir`. */
async function runContract(homeDir: string, label: string): Promise<void> {
  const connection = new AcpConnection({
    adapterId: "claude-code",
    homeDir,
    clientInfo: { name: "kvy-acp-contract", version: "0.0.0" },
  });
  connection.setPermissionHandler((params) => autoAllow(params));

  const workspace = mkdtempSync(join(tmpdir(), "kvy-acp-contract-ws-"));
  writeFileSync(join(workspace, "hello.txt"), "kvy acp contract workspace\n");

  try {
    await connection.connect();
    const agentInfo = connection.getAgentInfo();
    assertContract(agentInfo?.name, `[${label}] initialize returned no agentInfo.name`);
    console.log(`[acp-contract] ${label}: connected to ${agentInfo?.name} ${agentInfo?.version}`);

    const session = await connection.createSession({
      cwd: workspace,
      meta: {
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });
    assertContract(
      UUID_PATTERN.test(session.sessionId),
      `[${label}] session/new returned a non-UUID sessionId "${session.sessionId}" — breaks the claude --resume handoff (design §7.4)`,
    );

    // 1. Text turn.
    const text = await runTurn(
      connection,
      session.sessionId,
      "Reply with exactly this text and nothing else: hello kvy",
    );
    assertContract(
      text.stopReason === "end_turn",
      `[${label}] text turn stopReason was "${text.stopReason}", expected "end_turn"`,
    );
    assertContract(
      text.envelopes.some((e) => e.ev.t === "text"),
      `[${label}] text turn produced no 'text' envelope — agent_message_chunk mapping broke`,
    );
    console.log(`[acp-contract] ${label}: text turn OK (${text.envelopes.length} envelopes)`);

    // 2. Tool turn.
    const tool = await runTurn(
      connection,
      session.sessionId,
      "Use the Bash tool to run exactly `echo kvy-contract` and then confirm the output in one short sentence.",
    );
    const toolStart = tool.envelopes.find((e) => e.ev.t === "tool-start");
    assertContract(
      toolStart !== undefined,
      `[${label}] tool turn produced no 'tool-start' envelope — tool_call mapping broke`,
    );
    assertContract(
      toolStart?.ev.t === "tool-start" && toolStart.ev.name !== "tool",
      `[${label}] tool-start fell back to the generic name "tool" — _meta.claudeCode.toolName is missing (mapper assumption 2)`,
    );
    assertContract(
      tool.envelopes.some((e) => e.ev.t === "tool-end"),
      `[${label}] tool turn produced no 'tool-end' envelope — terminal tool_call_update mapping broke`,
    );
    console.log(
      `[acp-contract] ${label}: tool turn OK (tool-start name="${
        toolStart?.ev.t === "tool-start" ? toolStart.ev.name : "?"
      }")`,
    );
  } finally {
    await connection.disconnect();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function latestVersion(pkg: string): string | null {
  try {
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // --- pinned run (hard gate) ---
  const homeDir = mkdtempSync(join(tmpdir(), "kvy-acp-contract-home-"));
  try {
    const installed = await installAllAdapters({ homeDir });
    for (const outcome of installed) {
      assertContract(
        outcome.ok,
        `pinned adapter "${outcome.id}" failed to install: ${outcome.ok ? "" : outcome.error}`,
      );
    }
    await runContract(homeDir, "pinned");
    console.log("[acp-contract] pinned run PASSED");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }

  // --- latest canary (soft warning) ---
  const pkg = ADAPTER_MANIFEST["claude-code"].packageName;
  const pinnedVersion = ADAPTER_MANIFEST["claude-code"].version;
  const latest = latestVersion(pkg);
  if (!latest) {
    console.warn("[acp-contract] latest canary: could not resolve latest version — skipping");
    return;
  }
  if (latest === pinnedVersion) {
    console.log(
      `[acp-contract] latest canary: pin ${pinnedVersion} is already latest — nothing to check`,
    );
    return;
  }

  console.log(
    `[acp-contract] latest canary: upstream ${pkg}@${latest} > pinned ${pinnedVersion} — running structural canary`,
  );
  // The adapter manager verifies against the PINNED integrity hash, which
  // latest won't match — so the canary can't go through the manager. It's a
  // deliberately shallow structural check: install latest into a throwaway
  // prefix and assert its declared bin entrypoint still resolves and loads.
  // A renamed/removed entry (the most common breaking upstream change) is
  // caught here as a WARNING; deeper behavioral drift is caught by the pinned
  // run once someone bumps the pin. Never fails the build — latest breaking
  // isn't Kvy's bug yet, it's a signal to investigate before bumping.
  const canaryHome = mkdtempSync(join(tmpdir(), "kvy-acp-contract-canary-"));
  try {
    const prefix = join(canaryHome, "adapters");
    execFileSync(
      "npm",
      [
        "install",
        `${pkg}@${latest}`,
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--save-exact",
      ],
      { stdio: "inherit" },
    );
    const entry = join(
      prefix,
      "node_modules",
      ...pkg.split("/"),
      ADAPTER_MANIFEST["claude-code"].binEntry,
    );
    execFileSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
      stdio: "ignore",
      timeout: 30_000,
    });
    console.log(
      `[acp-contract] latest canary: ${pkg}@${latest} bin entry loads — bump the pin and re-run the full pinned contract`,
    );
  } catch (error) {
    console.warn(
      `[acp-contract] WARNING latest canary failed for ${pkg}@${latest}: ${
        error instanceof Error ? error.message : String(error)
      } — investigate upstream before bumping the pin`,
    );
  } finally {
    rmSync(canaryHome, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof ContractViolation ? "CONTRACT VIOLATION" : "ERROR";
  console.error(
    `[acp-contract] ${kind}: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
