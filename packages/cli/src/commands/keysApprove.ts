/**
 * `kvy keys approve` — answer another device's request for a copy of this account's
 * keys (docs/auth-ux-overhaul-plan.md AX-4.19).
 *
 * Deliberately a command a human runs, not a silent auto-approval: a device asking for
 * the master secret is asking for read access to everything, so anyone holding a stolen
 * account session would otherwise get it with no human in the loop. The printed
 * verification code is the control — it must match what the asking device shows.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { resolveBackendUrl } from "../auth/config.js";
import type { readCredentials as readCredentialsDefault } from "../auth/credentials.js";
import { ensureCredentials } from "../auth/ensureCredentials.js";
import { resolveKeyMaterial } from "../auth/keyMaterial.js";
import { sealKeysForPeer } from "../auth/keyShare.js";
import { resolveAccessToken } from "../auth/resolveAccessToken.js";
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { NO_TTY_CANNOT_SIGN_IN, REDUCED_CUSTODY } from "../ui/messages.js";

const MASTER_SECRET_LENGTH_BYTES = 32;

interface PendingKeyRequest {
  ephPub: string;
  label: string | null;
  createdAt: string;
  requesterClientKind: string | null;
}

export interface KeysApproveDeps {
  homeDir?: string;
  backendUrl?: string;
  fetchImpl?: typeof fetch;
  readCredentials?: (homeDir: string) => ReturnType<typeof readCredentialsDefault>;
  confirm?: (question: string) => Promise<boolean>;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  logger?: Logger;
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Mirrors `web/src/lib/verification-code.ts` — the same 6 digits must appear on both
 * screens, so this derivation is part of the contract, not a display detail. */
export function verificationCode(ephPub: string): string {
  const digest = createHash("sha256").update(ephPub, "utf8").digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function relative(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)} seconds ago`;
  return `${Math.round(seconds / 60)} minutes ago`;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function runKeysApproveCommand(deps: KeysApproveDeps = {}): Promise<number> {
  const homeDir = deps.homeDir ?? resolveHomeDir();
  const backendUrl = deps.backendUrl ?? resolveBackendUrl();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));
  const confirm = deps.confirm ?? defaultConfirm;
  const logger = deps.logger ?? noopLogger;

  const credentials = await ensureCredentials(logger, homeDir);
  if (!credentials.ok) {
    writeError(credentials.message);
    return 1;
  }

  const token = await resolveAccessToken(credentials.credentials, {
    backendUrl,
    homeDir,
    fetchImpl,
  });
  if (!token) {
    writeError(NO_TTY_CANNOT_SIGN_IN);
    return 1;
  }

  const masterSecret = await resolveKeyMaterial(credentials.credentials.keyMaterial, homeDir);
  if (!masterSecret || masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    writeError(REDUCED_CUSTODY);
    return 1;
  }

  let requests: PendingKeyRequest[];
  try {
    const res = await fetchImpl(`${backendUrl}/v1/keys/requests`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      writeError("kvy: couldn't reach the Kvy server. Try again.\n");
      return 1;
    }
    const body = (await res.json()) as { requests?: PendingKeyRequest[] };
    requests = body.requests ?? [];
  } catch {
    writeError("kvy: couldn't reach the Kvy server. Try again.\n");
    return 1;
  }

  if (requests.length === 0) {
    write("\n  No devices are waiting for your keys right now.\n\n");
    return 0;
  }

  for (const request of requests) {
    write("\n  A device is asking for a copy of your keys:\n\n");
    write(`    Signed in as   ${request.requesterClientKind ?? "unknown"}\n`);
    write(`    Says it is     ${request.label ?? "unnamed"}\n`);
    write(`    Asked          ${relative(request.createdAt)}\n\n`);
    write(
      `  Check that device shows this code:   ${formatCode(verificationCode(request.ephPub))}\n\n`,
    );
    write("  Only continue if the codes match.\n");

    if (!(await confirm("  Codes match, send my keys? [y/N] "))) {
      write("\n  Skipped.\n");
      continue;
    }

    const sealed = sealKeysForPeer(masterSecret, request.ephPub);
    if (!sealed) {
      writeError("\n  That request looks malformed, nothing was sent.\n");
      continue;
    }

    const res = await fetchImpl(`${backendUrl}/v1/keys/request/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ephPub: request.ephPub, response: sealed }),
    });
    if (!res.ok) {
      writeError("\n  That request is no longer waiting. Ask the device to try again.\n");
      continue;
    }
    write("\n  ✓ Keys sent. That device should continue on its own.\n\n");
  }

  return 0;
}
